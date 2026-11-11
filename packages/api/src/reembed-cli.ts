import { createDb, DEFAULT_DATABASE_URL } from "./db/client.js";
import { createProviders } from "./providers/index.js";
import { reembed } from "./reembed.js";
import { UsageRecorder, withUsageContext } from "./usage.js";

const { db, close } = createDb(
  process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
);
const usage = new UsageRecorder(db);
const providers = createProviders(process.env, undefined, usage.record);
const r = await withUsageContext(
  { userId: null, principal: null, operation: "reembed" },
  () => reembed(db, providers),
);
console.log(
  `embedded ${r.memories} memories and ${r.proposals} proposals with ${providers.embeddings.model}`,
);
await usage.flush();
await close();
