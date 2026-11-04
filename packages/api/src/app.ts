import { Hono } from "hono";
import { type AuthEnv, requireAuth } from "./auth.js";
import type { Db } from "./db/client.js";

export function createApp(db: Db) {
  const app = new Hono<AuthEnv>();

  // Unauthenticated: used by load balancers and `doctor`-style checks.
  app.get("/health", (c) => c.json({ ok: true }));

  const api = new Hono<AuthEnv>();
  api.use(requireAuth(db));
  api.get("/whoami", (c) => c.json({ name: c.get("principal") }));
  app.route("/api", api);

  return app;
}
