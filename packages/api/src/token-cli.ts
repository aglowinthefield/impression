import { createToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const name = process.argv[2];
if (!name) {
  console.error("usage: pnpm --filter @impression/api token:create <name>");
  process.exit(1);
}
const { db, close } = createDb(loadConfig().databaseUrl);
const token = await createToken(db, name);
await close();
console.log(`token for ${name} (shown once):\n${token}`);
