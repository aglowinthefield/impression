import { and, desc, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { memories, projects } from "./db/schema.js";

const query = z.object({
  project: z.string().min(1).optional(),
  /** Working path relative to the repo root. */
  path: z.string().min(1).optional(),
  /** Rough token budget for the whole set. */
  budget: z.coerce.number().int().min(50).max(20_000).default(800),
});

/** Rough token count: about four characters each. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * The small set worth showing at session start: pinned first, then by
 * confidence (unrated counts as middling), then newest. Flagged-stale and
 * superseded memories are left out. Stops at the budget, always keeping at
 * least one pinned memory that fits.
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
      or(eq(memories.scope, "user"), eq(memories.scope, "project")) as SQL,
      or(eq(memories.scope, "project"), eq(memories.owner, principal)) as SQL,
    ];
    if (q.project) {
      const [p] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, q.project));
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
    if (!q.path) where.push(isNull(memories.pathPrefix));
    else {
      const path = q.path.replace(/^\/+|\/+$/g, "");
      where.push(
        sql`(${memories.pathPrefix} IS NULL OR ${path} = ${memories.pathPrefix} OR starts_with(${path}, ${memories.pathPrefix} || '/'))`,
      );
    }

    const rows = await db
      .select()
      .from(memories)
      .where(and(...where))
      .orderBy(
        desc(memories.pinned),
        sql`coalesce(${memories.confidence}, 0.5) desc`,
        desc(memories.createdAt),
        desc(memories.id),
      )
      .limit(200);

    const items: { id: string; content: string; pinned: boolean }[] = [];
    let used = 0;
    for (const m of rows) {
      const cost = estimateTokens(m.content) + 2;
      if (used + cost > q.budget) continue;
      used += cost;
      items.push({ id: m.id, content: m.content, pinned: m.pinned });
    }
    return c.json({ items, tokens: used, budget: q.budget });
  });

  return app;
}
