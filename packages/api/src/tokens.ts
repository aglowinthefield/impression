import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { Access } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { apiTokens } from "./db/schema.js";

/** Admins see every token. Anyone else sees the tokens of their GitHub user. */
function visible(access: Access): SQL | undefined {
  if (access.admin) return undefined;
  return access.userId
    ? eq(apiTokens.userId, access.userId)
    : isNull(apiTokens.id);
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Lists tokens with where they were last used, and revokes them. */
export function tokenRoutes(db: Db) {
  const app = new Hono<AuthEnv>();

  app.get("/", async (c) => {
    const rows = await db
      .select()
      .from(apiTokens)
      .where(visible(c.get("access")))
      .orderBy(desc(apiTokens.lastUsedAt), desc(apiTokens.createdAt));
    const current = c.get("tokenId");
    return c.json({
      items: rows.map((t) => ({
        id: t.id,
        name: t.name,
        source: t.source,
        current: t.id === current,
        createdAt: iso(t.createdAt),
        revokedAt: iso(t.revokedAt),
        lastUsedAt: iso(t.lastUsedAt),
        lastClient: t.lastClient,
        lastIp: t.lastIp,
        lastRejectedAt: iso(t.lastRejectedAt),
        lastRejectedClient: t.lastRejectedClient,
        lastRejectedIp: t.lastRejectedIp,
      })),
    });
  });

  app.post("/:id/revoke", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return c.json({ error: "not found" }, 404);
    const [row] = await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, id),
          isNull(apiTokens.revokedAt),
          visible(c.get("access")),
        ),
      )
      .returning({ id: apiTokens.id });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
