import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { canReach } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { apiTokens, memories, sessions } from "./db/schema.js";

/**
 * How far a person has got with setup, for the dashboard's first-run steps and
 * `impression status`: repos the GitHub app reaches, whether a CLI is signed in, and
 * whether any session or memory has arrived. `?project=` adds whether that key is reachable.
 */
export function setupStatusRoutes(db: Db) {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const principal = c.get("principal");
    const access = c.get("access");
    const [cli] = await db
      .select({ n: count() })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.source, "cli"),
          isNull(apiTokens.revokedAt),
          access.userId
            ? eq(apiTokens.userId, access.userId)
            : sql`lower(${apiTokens.name}) = ${principal.toLowerCase()}`,
        ),
      );
    const [sent] = await db
      .select({ n: count() })
      .from(sessions)
      .where(eq(sessions.owner, principal));
    const [saved] = await db
      .select({ n: count() })
      .from(memories)
      .where(
        and(eq(memories.owner, principal), ne(memories.status, "retired")),
      );
    const project = c.req.query("project");
    return c.json({
      name: principal,
      admin: access.admin,
      repos: access.admin ? null : access.repos.size,
      cliSignedIn: (cli?.n ?? 0) > 0,
      sessions: sent?.n ?? 0,
      memories: saved?.n ?? 0,
      ...(project
        ? { project: { key: project, reachable: canReach(access, project) } }
        : {}),
    });
  });

  return app;
}
