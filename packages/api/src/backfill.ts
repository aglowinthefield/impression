import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Access, findProject } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db, Queryer } from "./db/client.js";
import {
  memories,
  projects,
  proposals,
  sessions,
  usageEvents,
} from "./db/schema.js";
import { logEvent } from "./events.js";
import { MAX_PROMPT_CHARS, SYSTEM } from "./extract.js";
import type { LlmProvider, Providers } from "./providers/index.js";
import { costMicros } from "./usage.js";

/** The usage operation backfill extraction records, so a person's spend can be summed. */
export const BACKFILL_OPERATION = "backfill";

/** Output tokens priced into each piece's estimate: extraction's `maxTokens`. */
export const ESTIMATE_OUTPUT_TOKENS = 2000;

/** A claim on a piece's extraction older than this is abandoned, by a crash or a lost request. */
export const CLAIM_MINUTES = 15;

/**
 * How long a backfill extraction's model call may take before it is aborted
 * and nothing is written. Well under `CLAIM_MINUTES`, so a live request never
 * outlives its claim.
 */
export const EXTRACT_DEADLINE_MS = 5 * 60_000;

/** Pieces in one plan request. A default run sends about 150. */
const MAX_PLAN_PIECES = 5000;

/** What a person has spent on backfill extraction, in millionths of a dollar. */
export async function backfillSpentMicros(
  db: Queryer,
  access: Access,
  principal: string,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string | null>`sum(${usageEvents.costMicros})`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.operation, BACKFILL_OPERATION),
        // A GitHub user's spend follows them across tokens; an admin token has only its name.
        access.userId
          ? eq(usageEvents.userId, access.userId)
          : eq(usageEvents.principal, principal),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Estimated cost in millionths of a dollar of extracting pieces of these sizes:
 * about 4 characters a token for the transcript (cut as extraction cuts it) and
 * the extraction prompt, plus a full reply each. 0 for a model with no known price.
 */
export function estimateMicros(llm: LlmProvider, chars: number[]): number {
  const promptTokens = Math.ceil(SYSTEM.length / 4);
  let total = 0;
  for (const c of chars) {
    total +=
      costMicros({
        kind: "completion",
        provider: llm.provider ?? "anthropic",
        model: llm.model,
        inputTokens:
          promptTokens + Math.ceil(Math.min(c, MAX_PROMPT_CHARS) / 4),
        outputTokens: ESTIMATE_OUTPUT_TOKENS,
      }) ?? 0;
  }
  return total;
}

/**
 * What extracting a session did, read back from its memory events: `saved` new
 * memories, and `updated` existing ones it superseded or merged into.
 */
export async function extractionCounts(db: Db, sessionId: string) {
  const rows = await db.execute<{ kind: string; n: string }>(sql`
    SELECT kind, count(*) AS n FROM memory_events
    WHERE session_id = ${sessionId} AND actor = 'extraction'
      AND kind IN ('extracted', 'superseded', 'merged')
    GROUP BY kind`);
  const n = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { saved: n("extracted"), updated: n("superseded") + n("merged") };
}

/**
 * Takes a backfill piece for extraction. Returns the claim, the stored
 * `extracting_at` as Postgres prints it (microseconds, which a Date would cut),
 * or null when the piece is extracted already or another request holds a live
 * claim on it.
 */
export async function claimPiece(
  db: Queryer,
  id: string,
): Promise<string | null> {
  const [claimed] = await db
    .update(sessions)
    .set({ extractingAt: sql`now()` })
    .where(
      and(
        eq(sessions.id, id),
        isNull(sessions.extractedAt),
        sql`(${sessions.extractingAt} IS NULL OR ${sessions.extractingAt} < now() - make_interval(mins => ${CLAIM_MINUTES}))`,
      ),
    )
    .returning({ at: sql<string>`${sessions.extractingAt}::text` });
  return claimed?.at ?? null;
}

/** Whether this row's claim is still `claim`, the one a request took. */
const holds = (id: string, claim: string) =>
  and(
    eq(sessions.id, id),
    sql`${sessions.extractingAt} = ${claim}::timestamptz`,
  );

/**
 * Marks a claimed piece extracted, only if the claim is still this request's.
 * False when the claim expired and another request took the piece over.
 */
export async function finishPiece(
  db: Queryer,
  id: string,
  claim: string,
): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ extractedAt: sql`now()`, extractingAt: null })
    .where(holds(id, claim))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** Thrown inside the write transaction when the claim is no longer this request's. */
export class ClaimLost extends Error {
  constructor() {
    super("backfill claim taken over");
    this.name = "ClaimLost";
  }
}

/**
 * Runs extraction's writes in one transaction that first locks the piece's row
 * and checks the claim is still `claim`, then marks the piece extracted. A
 * request whose claim expired and was taken over writes nothing (`ClaimLost`).
 * The row lock makes a takeover wait until this commits, by which time the
 * piece is extracted and can't be claimed.
 */
export function writeUnderClaim(
  db: Db,
  owner: string,
  id: string,
  claim: string,
) {
  return (work: (db: Queryer) => Promise<void>) =>
    db.transaction(async (tx) => {
      // One piece's writes at a time per person: the memories are theirs, so
      // two pieces could lock the same ones in turn, and each piece's dedup
      // must see the memories the one before it wrote.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`backfill-write:${owner}`}, 0))`,
      );
      const held = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(holds(id, claim))
        .for("update");
      if (held.length === 0) throw new ClaimLost();
      await work(tx);
      if (!(await finishPiece(tx, id, claim))) throw new ClaimLost();
    });
}

export type Admission =
  | { claim: string }
  | { claim: null; overBudget: true; spentMicros: number }
  | { claim: null; overBudget: false };

/**
 * Admits a backfill piece to extraction against the person's budget, and
 * claims it. One transaction holding a per-person advisory lock, so two
 * requests can't both pass on the same headroom: refuses when recorded spend,
 * plus the estimates of the person's other unexpired claims, plus this piece's
 * estimate, would pass the budget. Estimates are `estimateMicros`, as the plan
 * prices pieces. `claim: null` without `overBudget` means the piece is
 * extracted already or another request holds it.
 */
export async function admitPiece(
  db: Db,
  llm: LlmProvider,
  access: Access,
  s: { id: string; owner: string; transcript: string },
  budgetMicros: number,
): Promise<Admission> {
  return db.transaction(async (tx) => {
    // Spend follows a GitHub user across tokens, so the lock does too.
    const who = access.userId ?? `principal:${s.owner}`;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`backfill:${who}`}, 0))`,
    );
    const spent = await backfillSpentMicros(tx, access, s.owner);
    const inFlight = await tx
      .select({ chars: sql<number>`char_length(${sessions.transcript})` })
      .from(sessions)
      .where(
        and(
          eq(sessions.owner, s.owner),
          eq(sessions.source, "backfill"),
          isNull(sessions.extractedAt),
          ne(sessions.id, s.id),
          sql`${sessions.extractingAt} >= now() - make_interval(mins => ${CLAIM_MINUTES})`,
        ),
      );
    const committed =
      spent +
      estimateMicros(
        llm,
        inFlight.map((r) => Number(r.chars)),
      );
    if (committed + estimateMicros(llm, [s.transcript.length]) > budgetMicros)
      return { claim: null, overBudget: true, spentMicros: spent };
    const claim = await claimPiece(tx, s.id);
    return claim ? { claim } : { claim: null, overBudget: false };
  });
}

/** Gives a claim back after a failure, unless another request has taken the piece over. */
export async function releasePiece(db: Db, id: string, claim: string) {
  await db.update(sessions).set({ extractingAt: null }).where(holds(id, claim));
}

const planBody = z.object({
  /** The project key, or `{ key }` as sessions take it. */
  project: z.union([
    z.string().min(1),
    z.object({ key: z.string().min(1) }).transform((p) => p.key),
  ]),
  pieces: z
    .array(
      z.object({
        sessionKey: z.string().min(1).max(200).optional(),
        hash: z
          .string()
          .regex(/^[0-9a-f]{64}$/i, "hash must be a sha256 hex digest")
          .transform((h) => h.toLowerCase()),
        chars: z.number().int().min(0),
      }),
    )
    .max(MAX_PLAN_PIECES),
});

export function backfillRoutes(
  db: Db,
  providers: Providers,
  opts: { budgetUsd: number },
) {
  const app = new Hono<AuthEnv>();

  /**
   * Which pieces are new, already extracted by a backfill ("done"), or from a
   * session the hooks uploaded ("live"), with the new pieces' estimate and the
   * caller's budget. Reads only the caller's own sessions.
   */
  app.post("/plan", async (c) => {
    const parsed = planBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const { project: key, pieces } = parsed.data;
    const owner = c.get("principal");

    const [p] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.key, key));
    const hashes = [...new Set(pieces.map((x) => x.hash))];
    const done = new Set<string>();
    if (p && hashes.length) {
      const rows = await db
        .select({ hash: sessions.pieceHash })
        .from(sessions)
        .where(
          and(
            eq(sessions.owner, owner),
            eq(sessions.projectId, p.id),
            eq(sessions.source, "backfill"),
            inArray(sessions.pieceHash, hashes),
            sql`${sessions.extractedAt} IS NOT NULL`,
          ),
        );
      for (const r of rows) if (r.hash) done.add(r.hash);
    }
    const keys = [
      ...new Set(pieces.flatMap((x) => (x.sessionKey ? [x.sessionKey] : []))),
    ];
    const live = new Set<string>();
    if (keys.length) {
      const rows = await db
        .selectDistinct({ key: sessions.sessionKey })
        .from(sessions)
        .where(
          and(
            eq(sessions.owner, owner),
            eq(sessions.source, "hook"),
            inArray(sessions.sessionKey, keys),
          ),
        );
      for (const r of rows) if (r.key) live.add(r.key);
    }

    const out = pieces.map((x) => ({
      hash: x.hash,
      status: done.has(x.hash)
        ? ("done" as const)
        : x.sessionKey && live.has(x.sessionKey)
          ? ("live" as const)
          : ("new" as const),
    }));
    const newChars = pieces
      .filter((_, i) => out[i]?.status === "new")
      .map((x) => x.chars);
    const spent = await backfillSpentMicros(db, c.get("access"), owner);
    return c.json({
      pieces: out,
      estimateUsd: estimateMicros(providers.backfillLlm, newChars) / 1e6,
      budgetUsd: opts.budgetUsd,
      spentUsd: spent / 1e6,
      model: providers.backfillLlm.model,
    });
  });

  /**
   * Retires the caller's live memories that extraction wrote from backfilled
   * sessions of a project and filed in that project (or as the person's own
   * practices), each with an event so it can be undone. Superseded and retired
   * memories are history and stay as they are. 404 for a project the caller
   * can't see, as the other project routes answer.
   */
  app.post("/undo", async (c) => {
    const key = c.req.query("project");
    if (!key) return c.json({ error: "project is required" }, 400);
    const owner = c.get("principal");
    // Someone who lost access to the repo can't change memories others there see.
    const p = await findProject(db, c.get("access"), key);
    if (!p) return c.json({ error: "project not found" }, 404);
    const retired = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: memories.id,
          status: memories.status,
          staleReason: memories.staleReason,
          supersededBy: memories.supersededBy,
          sessionId: memories.sessionId,
        })
        .from(memories)
        .innerJoin(sessions, eq(memories.sessionId, sessions.id))
        .where(
          and(
            eq(memories.owner, owner),
            eq(sessions.owner, owner),
            eq(sessions.projectId, p.id),
            eq(sessions.source, "backfill"),
            inArray(memories.status, ["active", "possibly_stale"]),
            // Only memories filed in this repo, or the person's own practices;
            // never ones extraction filed in another repo the session touched.
            or(
              eq(memories.projectId, p.id),
              and(eq(memories.scope, "user"), isNull(memories.projectId)),
            ),
            // Only memories extraction wrote from this session, not a manual
            // memory that names it. Only extraction writes proposals, and a
            // memory one created is no older than the proposal; a memory one
            // merged into is. (A memory event isn't proof: a manual memory
            // with `agent: "extraction"` logs one too.)
            exists(
              tx
                .select({ one: sql`1` })
                .from(proposals)
                .where(
                  and(
                    eq(proposals.memoryId, memories.id),
                    eq(proposals.sessionId, memories.sessionId),
                    lte(proposals.createdAt, memories.createdAt),
                  ),
                ),
            ),
          ),
        )
        .for("update", { of: memories });
      if (rows.length === 0) return 0;
      await tx
        .update(memories)
        .set({ status: "retired", updatedAt: new Date() })
        .where(
          inArray(
            memories.id,
            rows.map((r) => r.id),
          ),
        );
      for (const r of rows)
        await logEvent(
          tx,
          r.id,
          "retired",
          {
            actor: "person",
            principal: owner,
            sessionId: r.sessionId,
            reason: "backfill undone",
          },
          {
            previous: {
              status: r.status,
              staleReason: r.staleReason,
              supersededBy: r.supersededBy,
            },
          },
        );
      return rows.length;
    });
    return c.json({ retired });
  });

  return app;
}
