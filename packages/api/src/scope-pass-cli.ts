import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createGithubClient } from "./github.js";
import { createProviders } from "./providers/index.js";
import { RepoAccess } from "./repo-access.js";
import { type ScopePassChange, runScopePass } from "./scope-pass.js";
import { UsageRecorder } from "./usage.js";

// Usage: db:scope-pass [--dry-run] [--before <iso timestamp>]
// Run once after the release, --dry-run first. A second run with the same
// --before changes nothing the first one changed or created.
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const at = args.indexOf("--before");
const started = new Date();
const before = at === -1 ? started : new Date(args[at + 1] ?? "");
if (Number.isNaN(before.getTime()) || before > started) {
  console.error(
    "usage: db:scope-pass [--dry-run] [--before <iso timestamp, not in the future>]",
  );
  process.exit(2);
}

const config = loadConfig();
const { db, close } = createDb(config.databaseUrl);
const usage = new UsageRecorder(db);
const providers = createProviders(process.env, undefined, usage.record);
const repos = config.github
  ? new RepoAccess(db, createGithubClient(config.github), config.github)
  : undefined;

const line = (s: string) => JSON.stringify(s.replace(/\s+/g, " "));
const print = (c: ScopePassChange) => {
  console.log(`\n${c.memoryId} (${c.owner})`);
  console.log(`  old:  ${line(c.old)}`);
  if (c.action === "retire") {
    console.log("  new:  retire");
    console.log(`  why:  ${line(c.why ?? "a to-do")}`);
  } else {
    console.log(`  new:  ${line(c.practice ?? "")}`);
    console.log(
      c.fact
        ? `  fact: ${c.fact.project}: ${line(c.fact.text)}`
        : "  fact: none, no repo the owner can access now takes it",
    );
    console.log("  why:  a practice carrying one repo's specifics");
  }
};

try {
  console.log(
    `${dryRun ? "dry run: " : ""}memories created before ${before.toISOString()}`,
  );
  const r = await runScopePass(db, providers, {
    before,
    dryRun,
    repos,
    onChange: print,
  });
  for (const s of r.skipped)
    console.log(
      `skipped ${s.memoryId} (${s.owner}): ${s.why === "changed" ? "changed while the pass ran" : "no readable reply"}`,
    );
  const retired = r.changes.filter((c) => c.action === "retire").length;
  const split = r.changes.length - retired;
  const dropped = r.changes.filter(
    (c) => c.action === "split" && !c.fact,
  ).length;
  console.log(
    `\n${dryRun ? "would change" : "changed"} ${r.changes.length}: ${split} split (${dropped} with the fact dropped), ${retired} retired; ${r.kept} kept, ${r.skipped.length} skipped`,
  );
  if (r.skipped.length) process.exitCode = 1;
} finally {
  await usage.flush();
  await close();
}
