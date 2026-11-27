import { and, desc, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { canReach, findProject, memoryVisible } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { memories, memoryServes, sessions } from "./db/schema.js";
import { PRACTICE_TAG } from "./extract.js";
import { logServes } from "./serves.js";

const query = z.object({
  project: z.string().min(1).optional(),
  /** Working path relative to the repo root. */
  path: z.string().min(1).optional(),
  /** Rough token budget for the whole set. */
  budget: z.coerce.number().int().min(50).max(20_000).default(800),
  /** The agent's own session id, recorded with what is served. Ignored when malformed. */
  session: z.string().min(1).max(200).optional().catch(undefined),
  agent: z.string().min(1).max(100).optional().catch(undefined),
});

/** Rough token count: about four characters each. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export interface CoreItem {
  id: string;
  content: string;
  tags: string[];
}

/** Share of the budget practices may take while other memories still want room. */
export const PRACTICE_SHARE = 0.25;

/**
 * Picks the core set from the memories matching `where`, until the budget runs out.
 * Memories that aren't practices fill all but PRACTICE_SHARE of the budget first,
 * practices then get their share plus whatever that left unused, and other
 * memories take any room practices didn't need. Within each group: confidence
 * (unrated counts as middling), then newest.
 */
export async function coreSet(
  db: Db,
  where: SQL[],
  budget: number,
): Promise<{ items: CoreItem[]; tokens: number }> {
  const rows = await db
    .select()
    .from(memories)
    .where(and(...where))
    .orderBy(
      sql`coalesce(${memories.confidence}, 0.5) desc`,
      desc(memories.createdAt),
      desc(memories.id),
    )
    .limit(200);
  const isPractice = (m: (typeof rows)[number]) =>
    m.tags.includes(PRACTICE_TAG);
  const chosen = new Set<(typeof rows)[number]>();
  let used = 0;
  const fill = (group: typeof rows, limit: number) => {
    for (const m of group) {
      if (chosen.has(m)) continue;
      const cost = estimateTokens(m.content) + 2;
      if (used + cost > limit) continue;
      used += cost;
      chosen.add(m);
    }
  };
  const others = rows.filter((m) => !isPractice(m));
  fill(others, budget - Math.floor(budget * PRACTICE_SHARE));
  fill(rows.filter(isPractice), budget);
  fill(others, budget);
  const items = rows
    .filter((m) => chosen.has(m))
    .map((m) => ({ id: m.id, content: m.content, tags: m.tags }));
  return { items, tokens: used };
}

/**
 * Whether a practice fits the project: it was learned in a session there, or a
 * prompt search there returned it before. Memories that aren't practices always pass.
 */
export function practiceFits(projectId: string | null): SQL {
  if (!projectId) return sql`NOT (${PRACTICE_TAG} = ANY(${memories.tags}))`;
  return sql`(NOT (${PRACTICE_TAG} = ANY(${memories.tags}))
    OR EXISTS (SELECT 1 FROM ${sessions} s WHERE s.id = ${memories.sessionId} AND s.project_id = ${projectId})
    OR EXISTS (SELECT 1 FROM ${memoryServes} v WHERE v.memory_id = ${memories.id} AND v.source = 'prompt' AND v.project_id = ${projectId}))`;
}

/**
 * The small set worth showing at session start: see `coreSet` for the order and
 * the practices' share. Only practices that fit the project are offered.
 * Flagged-stale and superseded memories are left out. Stops at the budget.
 */
export function coreRoutes(db: Db) {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const parsed = query.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const q = parsed.data;
    const principal = c.get("principal");

    const where: SQL[] = [
      eq(memories.status, "active"),
      await memoryVisible(db, c.get("access"), principal),
    ];
    let projectId: string | null = null;
    if (q.project) {
      const p = await findProject(db, c.get("access"), q.project);
      projectId = p?.id ?? null;
      // User memories without a project still apply everywhere.
      where.push(
        p
          ? (or(
              eq(memories.projectId, p.id),
              isNull(memories.projectId),
            ) as SQL)
          : isNull(memories.projectId),
      );
    }
    where.push(practiceFits(projectId));
    if (!q.path) where.push(isNull(memories.pathPrefix));
    else {
      const path = q.path.replace(/^\/+|\/+$/g, "");
      where.push(
        sql`(${memories.pathPrefix} IS NULL OR ${path} = ${memories.pathPrefix} OR starts_with(${path}, ${memories.pathPrefix} || '/'))`,
      );
    }

    const { items, tokens: used } = await coreSet(db, where, q.budget);
    await logServes(
      db,
      items.map((i) => i.id),
      {
        source: "core",
        principal,
        access: c.get("access"),
        projectId,
        sessionKey: q.session,
        agent: q.agent,
      },
    );
    return c.json({
      items,
      tokens: used,
      budget: q.budget,
      // Lets session start tell the person when this repo's sessions can't be saved.
      ...(q.project ? { reachable: canReach(c.get("access"), q.project) } : {}),
    });
  });

  return app;
}
