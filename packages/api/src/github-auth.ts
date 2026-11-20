import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createToken } from "./auth.js";
import type { GithubConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { apiTokens, users } from "./db/schema.js";
import type { GithubClient, GithubTokens } from "./github.js";
import { tokenCipher } from "./token-cipher.js";

export type SignInResult =
  | { ok: true; token: string; name: string }
  | {
      ok: false;
      reason: "not_allowed" | "needs_install" | "name_taken";
      login: string;
    };

/**
 * Turns a GitHub user token into an Impression token, if the person may use this server.
 * They may if at least one account that installed the app, and that they can use it on,
 * is on the allowlist. A browser sign-in replaces the user's previous browser token.
 * CLI tokens are kept, so a second machine doesn't sign the first one out.
 */
export async function signInWithGithub(
  db: Db,
  github: GithubClient,
  cfg: Pick<GithubConfig, "allowedAccounts" | "clientSecret">,
  tokens: GithubTokens,
  source: "web" | "cli",
): Promise<SignInResult> {
  const user = await github.getUser(tokens.accessToken);
  const installs = await github.listInstallations(tokens.accessToken);
  const allowed = new Set(cfg.allowedAccounts);
  if (!installs.some((i) => allowed.has(i.account.toLowerCase()))) {
    // Allowlisted people who haven't installed the app yet get a way forward.
    const reason =
      installs.length === 0 && allowed.has(user.login.toLowerCase())
        ? "needs_install"
        : "not_allowed";
    return { ok: false, reason, login: user.login };
  }
  // A token's name is the owner of what it writes. A GitHub login must not land on
  // an owner that a token from `token:create` already uses, or it would see that data.
  const [clash] = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.source, "manual"),
        isNull(apiTokens.revokedAt),
        sql`lower(${apiTokens.name}) = ${user.login.toLowerCase()}`,
      ),
    )
    .limit(1);
  if (clash) return { ok: false, reason: "name_taken", login: user.login };
  const cipher = tokenCipher(cfg.clientSecret);
  const sealed = {
    accessTokenEnc: cipher.seal(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken
      ? cipher.seal(tokens.refreshToken)
      : null,
    accessExpiresAt: tokens.expiresAt,
  };
  const [row] = await db
    .insert(users)
    .values({ githubId: user.id, login: user.login, ...sealed })
    .onConflictDoUpdate({
      target: users.githubId,
      set: { login: user.login, lastLoginAt: new Date(), ...sealed },
    })
    .returning({ id: users.id });
  const userId = (row as { id: string }).id;
  if (source === "web") {
    await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.userId, userId),
          eq(apiTokens.source, "web"),
          isNull(apiTokens.revokedAt),
        ),
      );
  }
  const token = await createToken(db, user.login, { userId, source });
  return { ok: true, token, name: user.login };
}

const STATE_COOKIE = "imp_oauth_state";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sign-in card on the meadow, matching the dashboard's login page. */
const PAGE_CSS = `
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;box-sizing:border-box;
font-family:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;color:#262a30;
background:#f0efeb url(/login-bg.png) center/cover;image-rendering:pixelated}
main{image-rendering:auto;background:#f7f6f3;border-radius:.5rem;box-shadow:0 10px 25px -5px rgb(0 0 0/.25);
padding:1.5rem;width:100%;max-width:24rem;display:grid;gap:1rem;line-height:1.5}
h1{font-size:1rem;font-weight:500;margin:0}p{margin:0}
.btn{display:block;text-align:center;background:#4a685a;color:#f0efeb;border-radius:.375rem;
padding:.4rem .75rem;font-size:.875rem;font-weight:600;text-decoration:none}
.back{font-size:.875rem}.back a{color:#4a685a}`;

function page(message: string, link?: { href: string; text: string }) {
  const a = link
    ? `<a class="btn" href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a>`
    : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" type="image/png" href="/favicon.png"><title>Impression</title><style>${PAGE_CSS}</style><main><h1>Impression</h1><p>${escapeHtml(message)}</p>${a}<p class="back"><a href="/">Back to sign in</a> · <a href="/start">Get started</a></p></main>`;
}

function refusal(
  r: Extract<SignInResult, { ok: false }>,
  cfg: GithubConfig,
): { message: string; link?: { href: string; text: string } } {
  if (r.reason === "needs_install" && cfg.appSlug) {
    return {
      message: `Hi ${r.login}. One more step: install the Impression GitHub app on your account, then sign in again. Impression works in the repos you give the app, so pick All repositories unless you want to leave some out.`,
      link: {
        href: `https://github.com/apps/${cfg.appSlug}/installations/new`,
        text: "Install the app",
      },
    };
  }
  if (r.reason === "name_taken") {
    return {
      message: `The name ${r.login} is already used by an API token on this server. Ask the owner to rename or revoke that token, then sign in again.`,
    };
  }
  return {
    message: `${r.login} isn't on this server's allowlist. Ask the owner to add your GitHub account or org.`,
  };
}

/** Sign-in routes, mounted at /auth. Not behind `requireAuth`. */
export function githubAuthRoutes(
  db: Db,
  github: GithubClient,
  cfg: GithubConfig,
) {
  const app = new Hono();
  const redirectUri = (reqUrl: string) =>
    `${cfg.publicUrl ?? new URL(reqUrl).origin}/auth/github/callback`;

  app.get("/github", (c) => {
    const state = randomBytes(16).toString("base64url");
    const uri = redirectUri(c.req.url);
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: uri.startsWith("https:"),
      path: "/auth",
      maxAge: 600,
    });
    return c.redirect(github.authorizeUrl(state, uri));
  });

  app.get("/github/callback", async (c) => {
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/auth" });
    const code = c.req.query("code");
    if (!expected || c.req.query("state") !== expected || !code) {
      return c.html(
        page("Sign-in expired or was tampered with. Try again."),
        400,
      );
    }
    let result: SignInResult;
    try {
      const tokens = await github.exchangeCode(code, redirectUri(c.req.url));
      result = await signInWithGithub(db, github, cfg, tokens, "web");
    } catch {
      return c.html(page("GitHub sign-in failed. Try again."), 502);
    }
    if (!result.ok) {
      const r = refusal(result, cfg);
      return c.html(page(r.message, r.link), 403);
    }
    // The fragment never reaches server logs; the SPA stores it and clears it.
    return c.redirect(`/#token=${encodeURIComponent(result.token)}`);
  });

  // Device flow for the CLI: the CLI never sees the GitHub client secret.
  app.post("/github/device", async (c) => {
    try {
      return c.json(await github.startDevice());
    } catch {
      return c.json({ error: "GitHub is unavailable" }, 502);
    }
  });

  app.post("/github/device/poll", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      deviceCode?: unknown;
    } | null;
    if (typeof body?.deviceCode !== "string" || !body.deviceCode) {
      return c.json({ error: "deviceCode is required" }, 400);
    }
    try {
      const poll = await github.pollDevice(body.deviceCode);
      if (poll.status === "pending" || poll.status === "slow_down") {
        return c.json({ status: poll.status }, 202);
      }
      if (poll.status !== "ok") {
        return c.json({ error: `sign-in ${poll.status}` }, 403);
      }
      const result = await signInWithGithub(
        db,
        github,
        cfg,
        poll.tokens,
        "cli",
      );
      if (!result.ok) {
        // The CLI prints only the error, so the link goes in the text.
        const r = refusal(result, cfg);
        const error = r.link ? `${r.message} ${r.link.href}` : r.message;
        return c.json({ error }, 403);
      }
      return c.json({ status: "ok", token: result.token, name: result.name });
    } catch {
      return c.json({ error: "GitHub is unavailable" }, 502);
    }
  });

  return app;
}
