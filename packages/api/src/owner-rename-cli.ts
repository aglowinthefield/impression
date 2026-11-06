import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { renameOwner } from "./owner-rename.js";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error(
    "usage: pnpm --filter @impression/api owner:rename <from> <to>",
  );
  process.exit(1);
}
const { db, close } = createDb(loadConfig().databaseUrl);
console.log(await renameOwner(db, from, to));
await close();
