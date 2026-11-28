import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Access, findProject } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { memories, projects, sessions, usageEvents } from "./db/schema.js";
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

/** Pieces in one plan request. A default run sends about 150. */
const MAX_PLAN_PIECES = 5000;

/** What a person has spent on backfill extraction, in millionths of a dollar. */
export async function backfillSpentMicros(
  db: Db,
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
export async function claimPiece(db: Db, id: string): Promise<string | null> {
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
  db: Db,
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
   * Retires the caller's live memories that came from backfilled sessions of a
   * project, each with an event so it can be undone. Superseded and retired
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
