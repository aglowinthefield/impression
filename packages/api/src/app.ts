import { Hono } from "hono";
import { type AuthEnv, requireAuth } from "./auth.js";
import type { Db } from "./db/client.js";
import { memoryRoutes } from "./memories.js";
import { proposalRoutes } from "./proposals.js";
import type { Providers } from "./providers/index.js";
import { searchRoutes } from "./search.js";
import { sessionRoutes } from "./sessions.js";

export function createApp(
  db: Db,
  providers: Providers,
  opts: { autoAcceptConfidence?: number | null } = {},
) {
  const app = new Hono<AuthEnv>();

  // Unauthenticated: used by load balancers and `doctor`-style checks.
  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono<AuthEnv>();
  api.use(requireAuth(db));
  api.route("/memories", memoryRoutes(db, providers));
  api.route("/search", searchRoutes(db, providers));
  api.route(
    "/sessions",
    sessionRoutes(db, providers, opts.autoAcceptConfidence ?? null),
  );
  api.route("/proposals", proposalRoutes(db, providers));
  api.get("/whoami", (c) => c.json({ name: c.get("principal") }));
  app.route("/api", api);

  return app;
}
