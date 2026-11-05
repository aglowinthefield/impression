import { asc } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { projects } from "./db/schema.js";

/** Projects are shared by every token, like project memories. */
export function projectRoutes(db: Db) {
  const app = new Hono<AuthEnv>();
  app.get("/", async (c) => {
    const rows = await db
      .select({ key: projects.key, name: projects.name })
      .from(projects)
      .orderBy(asc(projects.name), asc(projects.key));
    return c.json({ items: rows });
  });
  return app;
}
