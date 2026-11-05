import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSession, summarize } from "@impression/shared";

// Local only. Reads pi session logs and the live server's memories.
// `pnpm --filter @impression/api eval:sessions [sessionDirSubstring] [--turns]`
const args = process.argv.slice(2);
const showTurns = args.includes("--turns");
const filter = args.find((a) => !a.startsWith("--")) ?? "";
const root = join(homedir(), ".pi", "agent", "sessions");
const files = readdirSync(root)
  .filter((d) => d.includes(filter))
  .flatMap((d) =>
    readdirSync(join(root, d))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(root, d, f)),
  );
const cfg = JSON.parse(
  readFileSync(join(homedir(), ".config", "impression", "config.json"), "utf8"),
) as { url: string; token: string };
const res = await fetch(
  `${cfg.url.replace(/\/$/, "")}/api/memories?limit=200`,
  {
    headers: { authorization: `Bearer ${cfg.token}` },
  },
);
const stored = (
  (await res.json()) as {
    items: {
      id: string;
      content: string;
      status: string;
      project: string | null;
    }[];
  }
).items.filter((m) => m.status === "active");

const turns = files.flatMap((f) => parseSession(readFileSync(f, "utf8")));
const r = summarize(turns);
console.log(
  `${files.length} sessions, ${r.prompts} prompts, ${r.withMemories} (${Math.round((100 * r.withMemories) / Math.max(1, r.prompts))}%) got memories injected\n`,
);

const byText = new Map(stored.map((m) => [m.content, m]));
const shown = [...r.counts].sort((a, b) => b[1] - a[1]);
console.log("Most injected:");
for (const [t, n] of shown.slice(0, 10))
  console.log(
    `  ${String(n).padStart(3)}x ${byText.has(t) ? "" : "(gone) "}${t.slice(0, 110)}`,
  );
const never = stored.filter((m) => !r.counts.has(m.content));
console.log(
  `\nActive memories never injected (${never.length} of ${stored.length}), candidates to retire or reword:`,
);
for (const m of never.slice(0, 15))
  console.log(`  ${m.id.slice(0, 8)} ${m.content.slice(0, 110)}`);

if (showTurns) {
  console.log("\nTurns with injections (judge: did the reply use them?):");
  for (const t of turns.filter((t) => t.injected.length)) {
    console.log(`\n> ${t.prompt.slice(0, 120).replace(/\n/g, " ")}`);
    for (const m of t.injected) console.log(`    + ${m.slice(0, 110)}`);
    console.log(`    reply: ${t.reply.slice(0, 120).replace(/\n/g, " ")}`);
  }
}
