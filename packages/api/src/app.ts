import { relative } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AuthEnv, requireAuth } from "./auth.js";
import { coreRoutes } from "./core.js";
import type { Db } from "./db/client.js";
import { evalRoutes } from "./evals.js";
import { memoryRoutes } from "./memories.js";
import { projectRoutes } from "./projects.js";
import { proposalRoutes } from "./proposals.js";
import type { Providers } from "./providers/index.js";
import { RequestLog } from "./request-log.js";
import { searchRoutes } from "./search.js";
import { sessionRoutes } from "./sessions.js";

export function createApp(
  db: Db,
  providers: Providers,
  opts: {
    autoAcceptConfidence?: number | null;
    /** Directory of the built web UI. Served at / when set. */
    webDir?: string;
  } = {},
) {
  const app = new Hono<AuthEnv>();

  // Unauthenticated: used by load balancers and `doctor`-style checks.
  app.get("/health", (c) => c.json({ ok: true }));

  const log = new RequestLog();
  const api = new Hono<AuthEnv>();
  // Before auth, so rejected tokens show up in the log too.
  api.use(log.middleware());
  api.use(requireAuth(db));
  api.route("/debug", log.routes());
  api.route("/memories", memoryRoutes(db, providers));
  api.route("/core", coreRoutes(db));
  api.route("/search", searchRoutes(db, providers));
  api.route(
    "/sessions",
    sessionRoutes(db, providers, opts.autoAcceptConfidence ?? null),
  );
  api.route("/projects", projectRoutes(db));
  api.route("/evals", evalRoutes(db));
  api.route("/proposals", proposalRoutes(db, providers));
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
