import { and, asc } from "drizzle-orm";
import { Hono } from "hono";
import { projectIdCond } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { projects } from "./db/schema.js";

/** Lists the projects this request may see: every one for admin tokens, else the person's repos. */
export function projectRoutes(db: Db) {
  const app = new Hono<AuthEnv>();
  app.get("/", async (c) => {
    const rows = await db
      .select({ key: projects.key, name: projects.name })
      .from(projects)
      .where(and(await projectIdCond(db, c.get("access"), projects.id)))
      .orderBy(asc(projects.name), asc(projects.key));
    return c.json({ items: rows });
  });
  return app;
}
