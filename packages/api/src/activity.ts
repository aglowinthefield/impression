import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Access, findProject, memoryVisible } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db, Tx } from "./db/client.js";
import { anchors, memories, memoryEvents } from "./db/schema.js";
import { logEvent } from "./events.js";
import { embedMemory } from "./memories.js";
import type { Providers } from "./providers/index.js";

const PAGE = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Changes undo can reverse. Keeps, flags, dream runs and undos themselves can't be undone. */
const UNDOABLE = new Set([
  "extracted",
  "added",
  "merged",
  "superseded",
  "rewritten",
  "retired",
  "edited",
]);

const sources = ["extraction", "check", "dream", "person", "pass"] as const;

const listQuery = z.object({
  /** Leave out for every project you can see. */
  project: z.string().min(1).optional(),
  source: z.enum(sources).optional(),
  /** `<timestamp>|<id>` of the last entry on the previous page. */
  before: z
    .string()
    .regex(/^[0-9T:.\-+Z ]+\|[0-9a-f-]{36}$/i)
    .optional(),
});

export interface Entry {
  id: string;
  at: string;
  kind: string;
  actor: "extraction" | "check" | "person" | "dream" | "pass";
  principal: string | null;
  memory: {
    id: string;
    content: string;
    scope: string;
    status: string;
  } | null;
  before?: string;
  after?: string;
  reason: string;
  why?: string | null;
  session?: { id: string | null; agent: string | null };
  undoes?: string | null;
  run?: {
    created: number | null;
    kept: number | null;
    removed: number | null;
    uncategorized: number | null;
    concepts: number | null;
    error: string | null;
  };
  undone: boolean;
  canUndo: boolean;
}

type Replaced = { id: string; content: string; status: string };

interface EventRow extends Record<string, unknown> {
  id: string;
  at: string;
  kind: string;
  actor: "extraction" | "check" | "person" | "pass";
  principal: string | null;
  reason: string;
  detail: Record<string, unknown>;
  undone_by: string | null;
  undoes_kind: string | null;
  memory_id: string;
  content: string;
  scope: string;
  status: string;
  owner: string;
  session_id: string | null;
  session_owner: string | null;
  session_agent: string | null;
}

/** Microsecond-precise text, so a page cursor never skips or repeats an entry. */
const atText = (col: string) =>
  sql.raw(
    `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  );

function parseCursor(before: string | undefined) {
  if (!before) return null;
  const i = before.lastIndexOf("|");
  return { at: before.slice(0, i), id: before.slice(i + 1) };
}

/** Memories in the project, plus the viewer's own user-scoped memories, as on the Memories tab. */
function inProject(projectId: string | null): SQL {
  return projectId
    ? sql`(m.project_id = ${projectId} OR (m.scope = 'user' AND m.project_id IS NULL))`
    : sql`(m.scope = 'user' AND m.project_id IS NULL)`;
}

async function eventRows(
  db: Db,
  access: Access,
  principal: string,
  where: SQL[],
  limit: number,
): Promise<EventRow[]> {
  const visible = await memoryVisible(db, access, principal, "m");
  return db.execute<EventRow>(sql`
    SELECT e.id, ${atText("e.created_at")} AS at, e.kind, e.actor, e.principal, e.reason,
      e.detail, e.undone_by, u.kind AS undoes_kind,
      m.id AS memory_id, m.content, m.scope, m.status, m.owner,
      s.id AS session_id, s.owner AS session_owner, s.agent AS session_agent
    FROM memory_events e
    JOIN memories m ON m.id = e.memory_id
    LEFT JOIN sessions s ON s.id = e.session_id
    LEFT JOIN memory_events u ON u.id = e.undoes
    WHERE ${visible} AND ${sql.join(where, sql` AND `)}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${limit}`) as Promise<EventRow[]>;
}

/** Turns event rows into entries, leaving out replaced text the viewer can't see now. */
async function toEntries(
  db: Db,
  access: Access,
  principal: string,
  rows: EventRow[],
): Promise<Entry[]> {
  const replacedIds = rows.flatMap((r) =>
    r.kind === "superseded"
      ? ((r.detail.replaced as Replaced[] | undefined) ?? []).map((x) => x.id)
      : [],
  );
  const seen = new Set<string>();
  if (replacedIds.length > 0) {
    const ok = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          inArray(memories.id, replacedIds),
          await memoryVisible(db, access, principal),
        ),
      );
    for (const r of ok) seen.add(r.id);
  }
  return rows.map((r) => {
    const d = r.detail ?? {};
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    let before = text(d.before);
    let after = text(d.after);
    if (r.kind === "superseded") {
      const shown = ((d.replaced as Replaced[] | undefined) ?? []).filter((x) =>
        seen.has(x.id),
      );
      before = shown.length
        ? shown.map((x) => x.content).join("\n\n")
        : undefined;
      after = undefined;
    }
    if (r.kind === "rewritten" && !after) after = text(d.content);
    const undone = r.undone_by !== null;
    return {
      id: r.id,
      at: r.at,
      kind: r.kind,
      actor: r.actor,
      principal: r.principal,
      memory: {
        id: r.memory_id,
        content: r.content,
        scope: r.scope,
        status: r.status,
      },
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      reason: r.reason,
      ...(d.why !== undefined ? { why: (d.why as string | null) ?? null } : {}),
      ...(r.session_agent !== null || r.session_id !== null
        ? {
            session: {
              // Sessions are their owner's alone, so others see only the agent.
              id: r.session_owner === principal ? r.session_id : null,
              agent: r.session_agent,
            },
          }
        : {}),
      ...(r.kind === "undone" ? { undoes: r.undoes_kind } : {}),
      undone,
      canUndo: UNDOABLE.has(r.kind) && !undone && r.owner === principal,
    };
  });
}

class Refused extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 400,
    message: string,
  ) {
    super(message);
  }
}

/** Puts the memories an event changed back as they were before it. Returns memories to re-embed. */
async function reverse(
  tx: Tx,
  e: { kind: string; memoryId: string; detail: Record<string, unknown> },
): Promise<{ id: string; content: string }[]> {
  const now = new Date();
  const d = e.detail;
  const prev = (d.previous ?? {}) as {
    status?: "active" | "possibly_stale" | "superseded" | "retired";
    staleReason?: string | null;
    supersededBy?: string | null;
  };
  const retire = (id: string) =>
    tx
      .update(memories)
      .set({ status: "retired", updatedAt: now })
      .where(
        and(
          eq(memories.id, id),
          inArray(memories.status, ["active", "possibly_stale"]),
        ),
      );
  switch (e.kind) {
    case "extracted":
    case "added":
      await retire(e.memoryId);
      return [];
    case "superseded": {
      await retire(e.memoryId);
      for (const r of (d.replaced as Replaced[] | undefined) ?? []) {
        await tx
          .update(memories)
          .set({
            status: r.status === "possibly_stale" ? "possibly_stale" : "active",
            supersededBy: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(memories.id, r.id),
              eq(memories.status, "superseded"),
              eq(memories.supersededBy, e.memoryId),
            ),
          );
      }
      return [];
    }
    case "merged":
    case "edited": {
      const content = String(d.before ?? "");
      if (!content) throw new Refused(409, "this entry has no earlier text");
      await tx
        .update(memories)
        .set({
          content,
          embedding: null,
          embeddingModel: null,
          embeddingDim: null,
          updatedAt: now,
          ...(e.kind === "edited" && prev.status
            ? { status: prev.status, staleReason: prev.staleReason ?? null }
            : {}),
        })
        .where(eq(memories.id, e.memoryId));
      return [{ id: e.memoryId, content }];
    }
    case "rewritten": {
      if (typeof d.replacement === "string") await retire(d.replacement);
      await tx
        .update(memories)
        .set({
          status:
            prev.status === "possibly_stale" ? "possibly_stale" : "active",
          staleReason: prev.staleReason ?? null,
          supersededBy: null,
          updatedAt: now,
        })
        .where(eq(memories.id, e.memoryId));
      // The rewrite dropped anchors on deleted files from the old memory; put them back.
      const dropped = new Set((d.droppedAnchors as string[] | undefined) ?? []);
      const back = (
        (d.anchorsBefore as
          | {
              id: string;
              path: string;
              symbol: string | null;
              commitSha: string;
            }[]
          | undefined) ?? []
      ).filter((a) => dropped.has(a.id));
      if (back.length > 0)
        await tx
          .insert(anchors)
          .values(back.map((a) => ({ ...a, memoryId: e.memoryId })))
          .onConflictDoNothing();
      return [];
    }
    case "retired": {
      const status =
        prev.status && prev.status !== "retired" ? prev.status : "active";
      await tx
        .update(memories)
        .set({
          status,
          staleReason: prev.staleReason ?? null,
          ...(status === "superseded"
            ? { supersededBy: prev.supersededBy ?? null }
            : {}),
          updatedAt: now,
        })
        .where(
          and(eq(memories.id, e.memoryId), eq(memories.status, "retired")),
        );
      return [];
    }
    default:
      throw new Refused(400, "this change can't be undone");
  }
}

export function activityRoutes(db: Db, providers: Providers) {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const q = parsed.data;
    const principal = c.get("principal");
    const access = c.get("access");
    const p = q.project ? await findProject(db, access, q.project) : null;
    const cursor = parseCursor(q.before);

    let events: EventRow[] = [];
    if (q.source !== "dream") {
      const where: SQL[] = [q.project ? inProject(p?.id ?? null) : sql`true`];
      if (q.source) where.push(sql`e.actor = ${q.source}`);
      if (cursor)
        where.push(
          sql`(e.created_at, e.id::text) < (${cursor.at}::timestamptz, ${cursor.id})`,
        );
      events = await eventRows(db, access, principal, where, PAGE + 1);
    }

    let runs: Entry[] = [];
    if ((p || !q.project) && (!q.source || q.source === "dream")) {
      const rows = await db.execute<{
        id: string;
        at: string;
        created: number | null;
        kept: number | null;
        removed: number | null;
        uncategorized: number | null;
        concepts: number | null;
        error: string | null;
        trigger: string;
      }>(sql`
        SELECT id, ${atText("finished_at")} AS at, created, kept, removed, uncategorized,
          concepts, error, trigger
        FROM dream_runs
        WHERE owner = ${principal} ${p ? sql`AND project_id = ${p.id}` : sql``} AND finished_at IS NOT NULL
          ${cursor ? sql`AND (finished_at, id::text) < (${cursor.at}::timestamptz, ${cursor.id})` : sql``}
        ORDER BY finished_at DESC, id DESC
        LIMIT ${PAGE + 1}`);
      runs = rows.map((r) => ({
        id: r.id,
        at: r.at,
        kind: "dreamed",
        actor: "dream" as const,
        principal: null,
        memory: null,
        reason: r.trigger,
        run: {
          created: r.created,
          kept: r.kept,
          removed: r.removed,
          uncategorized: r.uncategorized,
          concepts: r.concepts,
          error: r.error,
        },
        undone: false,
        canUndo: false,
      }));
    }

    const all = [
      ...(await toEntries(db, access, principal, events)),
      ...runs,
    ].sort((a, b) =>
      a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1,
    );
    const items = all.slice(0, PAGE);
    const last = items[items.length - 1];
    return c.json({
      items,
      next: all.length > PAGE && last ? `${last.at}|${last.id}` : null,
    });
  });

  app.get("/summary", async (c) => {
    const project = c.req.query("project");
    const principal = c.get("principal");
    const access = c.get("access");
    const p = project ? await findProject(db, access, project) : null;
    const now = Date.now();
    const weeks = [0, 1, 2, 3].map((i) => ({
      week: new Date(now - (i + 1) * WEEK_MS).toISOString(),
      added: 0,
      rewritten: 0,
      retired: 0,
      /** Of this week's additions, the share retired since. */
      retireRate: null as number | null,
      addedNowRetired: 0,
    }));
    if (p || !project) {
      const visible = await memoryVisible(db, access, principal, "m");
      const rows = await db.execute<{
        w: number;
        kind: string;
        n: number;
        now_retired: number;
      }>(sql`
        SELECT greatest(0, floor(extract(epoch from (now() - e.created_at)) / ${WEEK_MS / 1000}))::int AS w,
          e.kind, count(*)::int AS n,
          count(*) FILTER (WHERE m.status = 'retired')::int AS now_retired
        FROM memory_events e JOIN memories m ON m.id = e.memory_id
        WHERE ${p ? sql`m.project_id = ${p.id}` : sql`true`} AND ${visible}
          AND e.created_at > now() - interval '28 days'
          AND e.undone_by IS NULL AND e.kind <> 'undone'
        GROUP BY 1, 2`);
      for (const r of rows) {
        const w = weeks[r.w];
        if (!w) continue;
        if (["extracted", "added", "superseded"].includes(r.kind)) {
          w.added += r.n;
          w.addedNowRetired += r.now_retired;
        }
        if (["rewritten", "superseded", "merged"].includes(r.kind))
          w.rewritten += r.n;
        if (r.kind === "retired") w.retired += r.n;
      }
      for (const w of weeks)
        w.retireRate = w.added
          ? Math.round((w.addedNowRetired / w.added) * 100)
          : null;
    }
    return c.json({
      weeks: weeks.map(({ addedNowRetired: _, ...w }) => w),
    });
  });

  app.post("/:id/undo", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success)
      return c.json({ error: "not found" }, 404);
    const principal = c.get("principal");
    const access = c.get("access");
    try {
      const { undoId, embed } = await db.transaction(async (tx) => {
        const [e] = await tx
          .select({ ev: memoryEvents, m: memories })
          .from(memoryEvents)
          .innerJoin(memories, eq(memories.id, memoryEvents.memoryId))
          .where(
            and(
              eq(memoryEvents.id, id),
              await memoryVisible(db, access, principal),
            ),
          )
          .for("update", { of: memoryEvents });
        if (!e) throw new Refused(404, "not found");
        if (e.m.owner !== principal)
          throw new Refused(403, "only the memory's author can undo this");
        if (!UNDOABLE.has(e.ev.kind))
          throw new Refused(400, "this change can't be undone");
        if (e.ev.undoneBy) throw new Refused(409, "already undone");
        const detail = (e.ev.detail ?? {}) as Record<string, unknown>;
        const touched = [e.ev.memoryId];
        if (e.ev.kind === "superseded")
          touched.push(
            ...((detail.replaced as Replaced[] | undefined) ?? []).map(
              (r) => r.id,
            ),
          );
        if (e.ev.kind === "rewritten" && typeof detail.replacement === "string")
          touched.push(detail.replacement);
        const later = await tx.execute(sql`
          SELECT 1 FROM memory_events
          WHERE memory_id IN (${sql.join(
            touched.map((t) => sql`${t}::uuid`),
            sql`, `,
          )})
            AND created_at > (SELECT created_at FROM memory_events WHERE id = ${e.ev.id})
            AND id <> ${e.ev.id} AND kind <> 'undone' AND undone_by IS NULL
          LIMIT 1`);
        if (later.length > 0)
          throw new Refused(
            409,
            "the memory changed since this entry; undo the later change first",
          );
        const embed = await reverse(tx, {
          kind: e.ev.kind,
          memoryId: e.ev.memoryId,
          detail,
        });
        const undoId = await logEvent(
          tx,
          e.ev.memoryId,
          "undone",
          { actor: "person", principal },
          { kind: e.ev.kind },
        );
        await tx
          .update(memoryEvents)
          .set({ undoes: e.ev.id })
          .where(eq(memoryEvents.id, undoId));
        const [claimed] = await tx
          .update(memoryEvents)
          .set({ undoneBy: undoId })
          .where(
            and(eq(memoryEvents.id, e.ev.id), isNull(memoryEvents.undoneBy)),
          )
          .returning({ id: memoryEvents.id });
        if (!claimed) throw new Refused(409, "already undone");
        return { undoId, embed };
      });
      for (const m of embed) await embedMemory(db, providers, m.id, m.content);
      const rows = await eventRows(
        db,
        access,
        principal,
        [sql`e.id = ${undoId}`],
        1,
      );
      const [entry] = await toEntries(db, access, principal, rows);
      return c.json(entry);
    } catch (err) {
      if (err instanceof Refused)
        return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  return app;
}
