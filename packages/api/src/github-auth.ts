import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createToken } from "./auth.js";
import type { GithubConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { apiTokens, users } from "./db/schema.js";
import type { GithubClient } from "./github.js";

export type SignInResult =
  | { ok: true; token: string; name: string }
  | { ok: false; reason: "not_allowed" | "needs_install"; login: string };

/**
 * Turns a GitHub user token into an Impression token, if the person may use this server.
 * They may if at least one account that installed the app, and that they can use it on,
 * is on the allowlist. A browser sign-in replaces the user's previous browser token.
 * CLI tokens are kept, so a second machine doesn't sign the first one out.
 */
export async function signInWithGithub(
  db: Db,
  github: GithubClient,
  cfg: Pick<GithubConfig, "allowedAccounts">,
  accessToken: string,
  source: "web" | "cli",
): Promise<SignInResult> {
  const user = await github.getUser(accessToken);
  const accounts = await github.listInstallationAccounts(accessToken);
  const allowed = new Set(cfg.allowedAccounts);
  if (!accounts.some((a) => allowed.has(a.toLowerCase()))) {
    // Allowlisted people who haven't installed the app yet get a way forward.
    const reason =
      accounts.length === 0 && allowed.has(user.login.toLowerCase())
        ? "needs_install"
        : "not_allowed";
    return { ok: false, reason, login: user.login };
  }
  const [row] = await db
    .insert(users)
    .values({ githubId: user.id, login: user.login })
    .onConflictDoUpdate({
      target: users.githubId,
      set: { login: user.login, lastLoginAt: new Date() },
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

function page(message: string, link?: { href: string; text: string }) {
  const a = link
    ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>`
    : "";
  return `<!doctype html><meta charset="utf-8"><title>Impression</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>Impression</h1><p>${escapeHtml(message)}</p>${a}<p><a href="/">Back to sign in</a></p>`;
}

function refusal(
  r: Extract<SignInResult, { ok: false }>,
  cfg: GithubConfig,
): { message: string; link?: { href: string; text: string } } {
  if (r.reason === "needs_install" && cfg.appSlug) {
    return {
      message: `Hi ${r.login}. Install the Impression GitHub app on your account, then sign in again.`,
      link: {
        href: `https://github.com/apps/${cfg.appSlug}/installations/new`,
        text: "Install the app",
      },
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
      const accessToken = await github.exchangeCode(
        code,
        redirectUri(c.req.url),
      );
      result = await signInWithGithub(db, github, cfg, accessToken, "web");
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
        poll.accessToken,
        "cli",
      );
      if (!result.ok)
        return c.json({ error: refusal(result, cfg).message }, 403);
      return c.json({ status: "ok", token: result.token, name: result.name });
    } catch {
      return c.json({ error: "GitHub is unavailable" }, 502);
    }
  });

  return app;
}
