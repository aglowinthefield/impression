import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { DREAM_EVERY, startDreamSchedule } from "./dream-schedule.js";
import { createGithubClient } from "./github.js";
import { createProviders } from "./providers/index.js";
import { RepoAccess } from "./repo-access.js";
import { sweepScopePass } from "./scope-pass.js";
import { UsageRecorder } from "./usage.js";

const config = loadConfig();
// The built web UI, if present (`pnpm --filter @impression/web build`).
const webDir =
  process.env.WEB_DIR ??
  fileURLToPath(new URL("../../web/dist", import.meta.url));
const { db } = createDb(config.databaseUrl);
const usage = new UsageRecorder(db);
const providers = createProviders(process.env, undefined, usage.record);
// Shared by requests and the scope pass, so both see the same repo access.
const repoAccess = config.github
  ? new RepoAccess(db, createGithubClient(config.github), config.github)
  : undefined;
serve({
  fetch: createApp(db, providers, {
    github: config.github,
    repoAccess,
    webDir: existsSync(webDir) ? webDir : undefined,
  }).fetch,
  port: config.port,
});
console.log(`impression api listening on :${config.port}`);

// The scope pass runs on this schedule even with dreaming off, so it finishes on its own.
startDreamSchedule(
  db,
  providers.dreamLlm,
  Number(process.env.DREAM_EVERY ?? DREAM_EVERY),
  {
    dreams: process.env.DREAM_SCHEDULE !== "off",
    jobs: [() => sweepScopePass(db, providers, { repos: repoAccess })],
  },
);

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
