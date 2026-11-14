import { and, desc, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { findProject, memoryVisible } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { memories } from "./db/schema.js";
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
        // Practices go first: they apply to whatever the session is about.
        sql`(${PRACTICE_TAG} = ANY(${memories.tags})) desc`,
        desc(memories.pinned),
        sql`coalesce(${memories.confidence}, 0.5) desc`,
        desc(memories.createdAt),
        desc(memories.id),
      )
      .limit(200);

    const items: {
      id: string;
      content: string;
      pinned: boolean;
      tags: string[];
    }[] = [];
    let used = 0;
    for (const m of rows) {
      const cost = estimateTokens(m.content) + 2;
      if (used + cost > q.budget) continue;
      used += cost;
      items.push({
        id: m.id,
        content: m.content,
        pinned: m.pinned,
        tags: m.tags,
      });
    }
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
    return c.json({ items, tokens: used, budget: q.budget });
  });

  return app;
}
