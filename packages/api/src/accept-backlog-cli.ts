import { acceptBacklog } from "./accept-backlog.js";
import { createDb, DEFAULT_DATABASE_URL } from "./db/client.js";
import { createProviders } from "./providers/index.js";
import { UsageRecorder, withUsageContext } from "./usage.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitAt = args.indexOf("--limit");
const limit = limitAt === -1 ? undefined : Number(args[limitAt + 1]);
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
  console.error("--limit takes a positive whole number");
  process.exit(1);
}
const { db, close } = createDb(
  process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
);
const usage = new UsageRecorder(db);
const providers = createProviders(process.env, undefined, usage.record);
try {
  const r = await withUsageContext(
    { userId: null, principal: null, operation: "accept-backlog" },
    () => acceptBacklog(db, providers, { dryRun, limit }),
  );
  console.log(
    dryRun
      ? `dry run: ${r.toAccept} to accept, ${r.belowFloor} below floor, ${r.noOwner} without an owner`
      : `created ${r.created}, superseded older memories with ${r.superseded}, ${r.duplicates} duplicates, ${r.merged} merged, ${r.belowFloor} below floor, ${r.empty} empty after scrubbing, ${r.noOwner} left pending without an owner, ${r.failed} failed and left pending`,
  );
  if (r.aborted) {
    console.error(
      "stopped after repeated failures: check EMBEDDING_* and LLM_* settings",
    );
    process.exitCode = 1;
  }
} finally {
  await usage.flush();
  await close();
}
