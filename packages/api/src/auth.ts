import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { Access, ADMIN_ACCESS } from "./access.js";
import type { Db } from "./db/client.js";
import { apiTokens } from "./db/schema.js";
import { ReauthRequired, type RepoAccess } from "./repo-access.js";

export const TOKEN_PREFIX = "imp_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a token for `name` and returns it. The plaintext is not recoverable afterwards. */
export async function createToken(
  db: Db,
  name: string,
  opts: { userId?: string; source?: "manual" | "web" | "cli" } = {},
): Promise<string> {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  await db.insert(apiTokens).values({
    name,
    tokenHash: hashToken(token),
    userId: opts.userId,
    source: opts.source ?? "manual",
  });
  return token;
}

export type AuthEnv = { Variables: { principal: string; access: Access } };

/** Requires `Authorization: Bearer <token>` matching an unrevoked token. Sets `principal` to its name. */
export function requireAuth(db: Db, repoAccess?: RepoAccess) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match) return c.json({ error: "missing bearer token" }, 401);
    const [row] = await db
      .select({ name: apiTokens.name, userId: apiTokens.userId })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.tokenHash, hashToken(match[1] as string)),
          isNull(apiTokens.revokedAt),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "invalid token" }, 401);
    c.set("principal", row.name);
    if (!row.userId) {
      c.set("access", ADMIN_ACCESS());
    } else {
      try {
        // Without GitHub sign-in configured, a GitHub user's token reaches nothing.
        const repos = repoAccess
          ? await repoAccess.reposFor(row.userId)
          : new Set<string>();
        c.set("access", new Access(false, row.userId, repos));
      } catch (err) {
        if (err instanceof ReauthRequired) {
          return c.json(
            { error: "GitHub sign-in expired, sign in again" },
            401,
          );
        }
        return c.json({ error: "couldn't check GitHub access" }, 503);
      }
    }
    await next();
  });
}
