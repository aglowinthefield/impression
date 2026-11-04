import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const { db } = createDb(config.databaseUrl);
serve({ fetch: createApp(db).fetch, port: config.port });
console.log(`impression api listening on :${config.port}`);
