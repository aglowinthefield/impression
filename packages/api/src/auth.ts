import { createHash, randomBytes } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
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

export type AuthEnv = {
  Variables: { principal: string; access: Access; tokenId: string };
};

/** Record a token's last use at most this often, unless its client or IP changed. */
const USAGE_EVERY_MS = 60_000;

/** Fly's view of the caller's IP, else the socket's. */
function clientIp(c: Context): string | null {
  const fly = c.req.header("fly-client-ip");
  if (fly) return fly;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** Requires `Authorization: Bearer <token>` matching an unrevoked token. Sets `principal` to its name. */
export function requireAuth(db: Db, repoAccess?: RepoAccess) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match) return c.json({ error: "missing bearer token" }, 401);
    const [row] = await db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        userId: apiTokens.userId,
        revokedAt: apiTokens.revokedAt,
        lastUsedAt: apiTokens.lastUsedAt,
        lastClient: apiTokens.lastClient,
        lastIp: apiTokens.lastIp,
      })
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hashToken(match[1] as string)))
      .limit(1);
    if (!row) return c.json({ error: "invalid token" }, 401);
    // Older clients don't name themselves, so their user agent stands in.
    const client = (
      c.req.header("x-impression-client") ??
      c.req.header("user-agent") ??
      "unknown"
    ).slice(0, 200);
    const ip = clientIp(c);
    if (row.revokedAt) {
      await db
        .update(apiTokens)
        .set({
          lastRejectedAt: sql`now()`,
          lastRejectedClient: client,
          lastRejectedIp: ip,
        })
        .where(eq(apiTokens.id, row.id));
      return c.json({ error: "invalid token" }, 401);
    }
    if (
      !row.lastUsedAt ||
      Date.now() - row.lastUsedAt.getTime() > USAGE_EVERY_MS ||
      row.lastClient !== client ||
      row.lastIp !== ip
    ) {
      await db
        .update(apiTokens)
        .set({ lastUsedAt: sql`now()`, lastClient: client, lastIp: ip })
        .where(eq(apiTokens.id, row.id));
    }
    c.set("principal", row.name);
    c.set("tokenId", row.id);
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
