import { eq } from "drizzle-orm";
import type { GithubConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { users } from "./db/schema.js";
import { GithubAuthError, type GithubClient } from "./github.js";
import { tokenCipher } from "./token-cipher.js";

/** The person's GitHub session is gone or they left the allowlist. They have to sign in again. */
export class ReauthRequired extends Error {}

/** Project keys for a GitHub repo, lowercased because GitHub names are case-insensitive. */
export const repoKey = (fullName: string) =>
  `github.com/${fullName}`.toLowerCase();

/**
 * Which repos a signed-in person can reach, from GitHub, cached per user. The
 * cache keeps the prompt hook fast, at the cost of revocation lagging by up to `ttlMs`.
 */
export class RepoAccess {
  private cache = new Map<string, { at: number; repos: Set<string> }>();
  private inflight = new Map<string, Promise<Set<string>>>();
  private cipher;
  private ttlMs: number;
  private now: () => number;

  constructor(
    private db: Db,
    private github: GithubClient,
    private cfg: Pick<GithubConfig, "clientSecret" | "allowedAccounts">,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.cipher = tokenCipher(cfg.clientSecret);
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Throws ReauthRequired when the person must sign in again, or another error if GitHub is unreachable and nothing is cached. */
  async reposFor(userId: string): Promise<Set<string>> {
    const hit = this.cache.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.repos;
    let p = this.inflight.get(userId);
    if (!p) {
      p = this.load(userId).finally(() => this.inflight.delete(userId));
      this.inflight.set(userId, p);
    }
    try {
      return await p;
    } catch (err) {
      if (err instanceof ReauthRequired) {
        this.cache.delete(userId);
        throw err;
      }
      // GitHub is down or slow: the last known set beats locking everyone out.
      if (hit) return hit.repos;
      throw err;
    }
  }

  private async load(userId: string): Promise<Set<string>> {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    let access = this.cipher.open(u?.accessTokenEnc ?? null);
    if (!u || !access) throw new ReauthRequired("no GitHub session");

    if (
      u.accessExpiresAt &&
      u.accessExpiresAt.getTime() - this.now() < 60_000
    ) {
      const refresh = this.cipher.open(u.refreshTokenEnc);
      if (!refresh) throw new ReauthRequired("GitHub session expired");
      try {
        const tokens = await this.github.refresh(refresh);
        access = tokens.accessToken;
        await this.db
          .update(users)
          .set({
            accessTokenEnc: this.cipher.seal(tokens.accessToken),
            refreshTokenEnc: tokens.refreshToken
              ? this.cipher.seal(tokens.refreshToken)
              : null,
            accessExpiresAt: tokens.expiresAt,
          })
          .where(eq(users.id, userId));
      } catch (err) {
        if (!(err instanceof GithubAuthError)) throw err;
        await this.db
          .update(users)
          .set({ accessTokenEnc: null, refreshTokenEnc: null })
          .where(eq(users.id, userId));
        throw new ReauthRequired("GitHub session expired");
      }
    }

    try {
      const installs = await this.github.listInstallations(access);
      const allowed = new Set(this.cfg.allowedAccounts);
      if (!installs.some((i) => allowed.has(i.account.toLowerCase()))) {
        throw new ReauthRequired("no longer on the allowlist");
      }
      const repos = new Set<string>();
      for (const i of installs) {
        for (const name of await this.github.listInstallationRepos(
          access,
          i.id,
        )) {
          repos.add(repoKey(name));
        }
      }
      this.cache.set(userId, { at: this.now(), repos });
      return repos;
    } catch (err) {
      if (err instanceof GithubAuthError) {
        throw new ReauthRequired("GitHub rejected the session");
      }
      throw err;
    }
  }
}
