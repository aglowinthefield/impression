import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createProviders } from "./providers/index.js";

const config = loadConfig();
// The built web UI, if present (`pnpm --filter @impression/web build`).
const webDir =
  process.env.WEB_DIR ??
  fileURLToPath(new URL("../../web/dist", import.meta.url));
const { db } = createDb(config.databaseUrl);
serve({
  fetch: createApp(db, createProviders(), {
    autoAcceptConfidence: config.autoAcceptConfidence,
    github: config.github,
    webDir: existsSync(webDir) ? webDir : undefined,
  }).fetch,
  port: config.port,
});
console.log(`impression api listening on :${config.port}`);
