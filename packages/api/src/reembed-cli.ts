import { createDb, DEFAULT_DATABASE_URL } from "./db/client.js";
import { createProviders } from "./providers/index.js";
import { reembed } from "./reembed.js";

const { db, close } = createDb(
  process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
);
const providers = createProviders();
const r = await reembed(db, providers);
console.log(
  `embedded ${r.memories} memories and ${r.proposals} proposals with ${providers.embeddings.model}`,
);
await close();
