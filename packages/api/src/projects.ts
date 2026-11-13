import { and, asc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { projectIdCond } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { projects } from "./db/schema.js";

/**
 * Lists the projects this request may see: every one for admin tokens, else the person's repos.
 * Most recently active first, so the web UI can open on the project you were just working in.
 */
// Latest memory or session upload. greatest() skips nulls, so either one alone counts.
// Written as raw SQL because drizzle leaves columns unqualified inside a subquery,
// which would make "id" resolve to the inner table.
const lastActive = sql<string | null>`greatest(
  (select max(m.created_at) from memories m where m.project_id = "projects"."id"),
  (select max(s.created_at) from sessions s where s.project_id = "projects"."id")
)`;

export function projectRoutes(db: Db) {
  const app = new Hono<AuthEnv>();
  app.get("/", async (c) => {
    const rows = await db
      .select({ key: projects.key, name: projects.name, lastActive })
      .from(projects)
      .where(and(await projectIdCond(db, c.get("access"), projects.id)))
      .orderBy(sql`${lastActive} desc nulls last`, asc(projects.name));
    return c.json({
      items: rows.map((r) => ({
        ...r,
        lastActive: r.lastActive ? new Date(r.lastActive).toISOString() : null,
      })),
    });
  });
  return app;
}
