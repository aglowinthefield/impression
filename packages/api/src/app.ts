import { relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AuthEnv, requireAuth } from "./auth.js";
import type { GithubConfig } from "./config.js";
import { coreRoutes } from "./core.js";
import type { Db } from "./db/client.js";
import { evalRoutes } from "./evals.js";
import { createGithubClient, type GithubClient } from "./github.js";
import { githubAuthRoutes } from "./github-auth.js";
import { memoryRoutes } from "./memories.js";
import { projectRoutes } from "./projects.js";
import type { Providers } from "./providers/index.js";
import { recheckRoutes } from "./recheck.js";
import { RepoAccess } from "./repo-access.js";
import { RequestLog } from "./request-log.js";
import { searchRoutes } from "./search.js";
import { sessionRoutes } from "./sessions.js";
import { settingsRoutes } from "./settings.js";
import { usageContext } from "./usage.js";

export function createApp(
  db: Db,
  providers: Providers,
  opts: {
    /** Directory of the built web UI. Served at / when set. */
    webDir?: string;
    /** Turns on GitHub sign-in. */
    github?: GithubConfig | null;
    /** Replaces the real GitHub client, for tests. */
    githubClient?: GithubClient;
    /** Replaces the default 10-minute repo access cache, for tests. */
    repoAccess?: RepoAccess;
  } = {},
) {
  const app = new Hono<AuthEnv>();

  // Unauthenticated: used by load balancers and `doctor`-style checks.
  app.get("/health", (c) => c.json({ ok: true }));

  // Lets the login page decide whether to show the GitHub button.
  app.get("/auth/config", (c) => c.json({ github: Boolean(opts.github) }));
  const github = opts.github
    ? (opts.githubClient ?? createGithubClient(opts.github))
    : null;
  if (opts.github && github) {
    app.route("/auth", githubAuthRoutes(db, github, opts.github));
  }
  const repoAccess =
    opts.repoAccess ??
    (opts.github && github
      ? new RepoAccess(db, github, opts.github)
      : undefined);

  const log = new RequestLog();
  const api = new Hono<AuthEnv>();
  // Before auth, so rejected tokens show up in the log too.
  api.use(log.middleware());
  api.use(requireAuth(db, repoAccess));
  api.use(usageContext());
  api.route("/debug", log.routes());
  api.route("/memories", recheckRoutes(db, providers));
  api.route("/memories", memoryRoutes(db, providers));
  api.route("/core", coreRoutes(db));
  api.route("/search", searchRoutes(db, providers));
  api.route("/sessions", sessionRoutes(db, providers));
  api.route("/projects", projectRoutes(db));
  api.route("/evals", evalRoutes(db));
  api.route("/settings", settingsRoutes(db));
  api.get("/whoami", (c) => c.json({ name: c.get("principal") }));
  app.route("/api", api);

  if (opts.webDir) {
    const root = relative(process.cwd(), opts.webDir) || ".";
    app.use("/*", serveStatic({ root }));
    // Single-page app: unknown non-API paths get index.html.
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  return app;
}
