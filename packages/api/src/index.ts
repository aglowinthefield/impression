import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createProviders } from "./providers/index.js";
import { UsageRecorder } from "./usage.js";

const config = loadConfig();
// The built web UI, if present (`pnpm --filter @impression/web build`).
const webDir =
  process.env.WEB_DIR ??
  fileURLToPath(new URL("../../web/dist", import.meta.url));
const { db } = createDb(config.databaseUrl);
const usage = new UsageRecorder(db);
serve({
  fetch: createApp(db, createProviders(process.env, undefined, usage.record), {
    autoAcceptConfidence: config.autoAcceptConfidence,
    github: config.github,
    webDir: existsSync(webDir) ? webDir : undefined,
  }).fetch,
  port: config.port,
});
console.log(`impression api listening on :${config.port}`);

// Prometheus metrics on a separate port, so they never reach the public listener.
const metricsPort = Number(process.env.METRICS_PORT ?? 9091);
serve({
  fetch: (req) =>
    new URL(req.url).pathname === "/metrics"
      ? new Response(usage.metrics.render(), {
          headers: { "content-type": "text/plain; version=0.0.4" },
        })
      : new Response("not found", { status: 404 }),
  port: metricsPort,
});
