import { acceptBacklog } from "./accept-backlog.js";
import { createDb, DEFAULT_DATABASE_URL } from "./db/client.js";
import { createProviders } from "./providers/index.js";
import { UsageRecorder, withUsageContext } from "./usage.js";

const dryRun = process.argv.includes("--dry-run");
const { db, close } = createDb(
  process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
);
const usage = new UsageRecorder(db);
const providers = createProviders(process.env, undefined, usage.record);
const r = await withUsageContext(
  { userId: null, principal: null, operation: "accept-backlog" },
  () => acceptBacklog(db, providers, { dryRun }),
);
console.log(
  dryRun
    ? `dry run: ${r.toAccept} to accept, ${r.belowFloor} below floor, ${r.noOwner} without an owner`
    : `accepted ${r.accepted}, dropped ${r.duplicates} as duplicates, ${r.belowFloor} below floor, ${r.empty} empty after scrubbing, ${r.noOwner} left pending without an owner`,
);
await usage.flush();
await close();
