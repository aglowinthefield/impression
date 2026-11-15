import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProject, sessionHeader } from "@impression/shared";
import { and, eq, gte, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import postgres from "postgres";
import { coreSet } from "../core.js";
import { createDb, type Db, DEFAULT_DATABASE_URL } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { memories, projects } from "../db/schema.js";
import { dream } from "../dream.js";
import { createProviders, type ModelUsage } from "../providers/index.js";
import { conceptStart } from "../session-start.js";
import { costMicros } from "../usage.js";
import {
  countLabels,
  JUDGE_SYSTEM,
  judgePrompt,
  parseVerdict,
  renderConcepts,
  renderTopN,
  type SessionResult,
  summarize,
} from "./session-start.js";

// Local only. Compares the concept version of the session-start set against
// today's top-N set on recent pi sessions, judged by a model.
// DATABASE_URL points at a copy of the server's database; it is only read.
// `pnpm --filter @impression/api eval:session-start [--owner login] [--sessions 40] [--dry] [--out file]`
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const owner = flag("owner") ?? "aglowinthefield";
const want = Number(flag("sessions") ?? 40);
const out = flag("out") ?? "/tmp/session-start-eval.json";
const dry = args.includes("--dry");
const BUDGET = 800;
/** Memories a project needs before the cutoff to be worth grouping. */
const MIN_MEMORIES = 15;
/** Sessions with fewer prompts than this say too little about what was needed. */
const MIN_PROMPTS = 2;
/** About 30,000 tokens of transcript per judgement. */
const MAX_TRANSCRIPT = 120_000;

interface Found {
  file: string;
  key: string;
  name: string;
  path: string | null;
  start: number;
  prompts: number;
}

/** User and assistant text only, without what Impression injected. */
function transcript(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type !== "message") continue;
      const role = e.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const c = e.message.content;
      const t =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .filter((p: { type?: string }) => p?.type === "text")
                .map((p: { text?: string }) => p.text ?? "")
                .join("")
            : "";
      if (t.trim()) out.push(`${role}: ${t.trim()}`);
    } catch {}
  }
  return out.join("\n\n").slice(0, MAX_TRANSCRIPT);
}

function findSessions(): Found[] {
  const root = join(homedir(), ".pi", "agent", "sessions");
  const resolved = new Map<string, ReturnType<typeof resolveProject> | null>();
  const found: Found[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(root, d.name))) {
      if (!f.endsWith(".jsonl")) continue;
      const file = join(root, d.name, f);
      const raw = readFileSync(file, "utf8");
      const head = sessionHeader(raw);
      if (!head) continue;
      // Removed worktrees no longer resolve; their repo root still does.
      const cwd = head.cwd.replace(/\/\.worktrees\/[^/]+/, "");
      if (!resolved.has(cwd)) {
        try {
          resolved.set(cwd, resolveProject(cwd));
        } catch {
          resolved.set(cwd, null);
        }
      }
      const p = resolved.get(cwd);
      if (!p) continue;
      let start = 0;
      let prompts = 0;
      for (const line of raw.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.type === "message" && e.message?.role === "user") {
            prompts++;
            if (!start) start = Date.parse(e.timestamp);
          }
        } catch {}
      }
      if (prompts >= MIN_PROMPTS && start)
        found.push({
          file,
          key: p.key,
          name: p.name,
          path: p.pathPrefix,
          start,
          prompts,
        });
    }
  }
  return found.sort((a, b) => b.start - a.start);
}

/** Memories that existed at the cutoff, as they stood then as far as the table can tell. */
async function snapshot(src: Db, projectId: string, cutoff: Date) {
  const rows = await src
    .select()
    .from(memories)
    .where(
      and(
        lt(memories.createdAt, cutoff),
        or(
          and(eq(memories.owner, owner), ne(memories.scope, "team")),
          eq(memories.scope, "team"),
        ),
        or(eq(memories.projectId, projectId), isNull(memories.projectId)),
        // A memory retired after the cutoff was still live at it.
        or(eq(memories.status, "active"), gte(memories.updatedAt, cutoff)),
      ),
    );
  return rows.map(({ search: _s, ...m }) => ({
    ...m,
    status: m.status === "possibly_stale" ? m.status : ("active" as const),
    supersededBy: null,
    sessionId: null,
  }));
}

async function scratchDb(adminUrl: string) {
  const name = `impression_eval_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const admin = postgres(adminUrl);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  await runMigrations(url.toString());
  const ctx = createDb(url.toString());
  return {
    db: ctx.db,
    async drop() {
      await ctx.close();
      const a = postgres(adminUrl);
      await a.unsafe(`DROP DATABASE ${name}`);
      await a.end();
    },
  };
}

const srcUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const src = createDb(srcUrl);
let spent = 0;
const providers = createProviders(
  process.env,
  undefined,
  async (u: ModelUsage) => {
    spent += costMicros(u) ?? 0;
  },
);

// Spread sessions across projects: newest first, round robin.
const known = new Map(
  (await src.db.select().from(projects)).map((p) => [p.key, p]),
);
const byProject = new Map<string, Found[]>();
for (const s of findSessions())
  if (known.has(s.key))
    byProject.set(s.key, [...(byProject.get(s.key) ?? []), s]);

const countBefore = async (projectId: string, cutoff: Date) =>
  (
    await src.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memories)
      .where(
        and(
          eq(memories.projectId, projectId),
          lt(memories.createdAt, cutoff),
          sql`not ('practice' = any(${memories.tags}))`,
          or(eq(memories.owner, owner), eq(memories.scope, "team")),
        ),
      )
  )[0]?.n ?? 0;

// Only sessions with enough memories before them qualify. Then newest first,
// round robin across projects; a project's cutoff is its oldest pick.
const queues: [string, Found[]][] = [];
for (const [key, list] of byProject) {
  const projectId = known.get(key)?.id;
  if (!projectId) continue;
  const ok: Found[] = [];
  for (const s of list)
    if ((await countBefore(projectId, new Date(s.start))) >= MIN_MEMORIES)
      ok.push(s);
  if (ok.length) queues.push([key, ok]);
}
const picked = new Map<string, Found[]>();
let total = 0;
while (total < want && queues.some(([, q]) => q.length)) {
  for (const [k, q] of queues) {
    const s = q.shift();
    if (!s || total >= want) continue;
    picked.set(k, [...(picked.get(k) ?? []), s]);
    total++;
  }
}
// Each session gets its own snapshot, taken at its start, and its own dream.
const plan = [...picked].flatMap(([key, list]) =>
  list.map((s) => ({ key, projectId: known.get(key)?.id ?? "", s })),
);
for (const p of plan)
  console.log(
    `${p.key} ${new Date(p.s.start).toISOString()}: ${p.s.prompts} prompts, ${await countBefore(p.projectId, new Date(p.s.start))} memories before`,
  );
if (dry) {
  await src.close();
  process.exit(0);
}

const results: (SessionResult & {
  project: string;
  file: string;
  topNText: string;
  conceptText: string;
})[] = [];
for (const { key, projectId, s } of plan) {
  const project = known.get(key);
  if (!project) continue;
  const scratch = await scratchDb(srcUrl);
  try {
    await scratch.db.insert(projects).values({ ...project, createdBy: null });
    const snap = await snapshot(src.db, projectId, new Date(s.start));
    if (snap.length) await scratch.db.insert(memories).values(snap);
    const d = await dream(scratch.db, providers.dreamLlm, projectId, owner);
    const where: SQL[] = [
      eq(memories.status, "active"),
      or(eq(memories.projectId, projectId), isNull(memories.projectId)) as SQL,
      s.path
        ? sql`(${memories.pathPrefix} IS NULL OR ${s.path} = ${memories.pathPrefix} OR starts_with(${s.path}, ${memories.pathPrefix} || '/'))`
        : isNull(memories.pathPrefix),
    ];
    const core = await coreSet(scratch.db, where, BUDGET);
    const cs = await conceptStart(
      scratch.db,
      projectId,
      owner,
      core.items,
      BUDGET,
    );
    const topN = renderTopN(project.name, core.items);
    const concepts = renderConcepts(project.name, cs);
    const conceptsWere = Math.random() < 0.5 ? "A" : "B";
    const [a, b] = conceptsWere === "A" ? [concepts, topN] : [topN, concepts];
    const reply = await providers.dreamLlm.complete({
      system: JUDGE_SYSTEM,
      prompt: judgePrompt(transcript(readFileSync(s.file, "utf8")), a, b),
      maxTokens: 4000,
    });
    const verdict = parseVerdict(reply);
    if (!verdict) {
      console.log(`${key} ${s.file}: no usable verdict, skipped`);
      continue;
    }
    const [cl, tl] =
      conceptsWere === "A" ? [verdict.a, verdict.b] : [verdict.b, verdict.a];
    results.push({
      project: key,
      file: s.file,
      conceptsWere,
      verdict,
      topN: countLabels(topN, tl),
      concepts: countLabels(concepts, cl),
      topNText: topN.text,
      conceptText: concepts.text,
    });
    const winner =
      verdict.better === "tie"
        ? "tie"
        : verdict.better === conceptsWere
          ? "concepts"
          : "top-N";
    console.log(
      `${key} ${new Date(s.start).toISOString()} (${snap.length} memories, ${d.concepts} concepts) ${winner}: ${verdict.why}`,
    );
    writeFileSync(out, JSON.stringify({ results }, null, 2));
  } finally {
    await scratch.drop();
  }
}

const sum = summarize(results);
writeFileSync(out, JSON.stringify({ summary: sum, results }, null, 2));
const pct = (x: number) => `${Math.round(x * 100)}%`;
console.log(`
sessions ${sum.sessions}: concepts won ${sum.conceptWins}, tied ${sum.ties}, top-N won ${sum.topNWins}
helpful memories: top-N ${pct(sum.topNHelpful)}, concepts ${pct(sum.conceptHelpful)}; topic lines helpful ${pct(sum.topicHelpful)}
misleading memories: top-N ${pct(sum.topNMisleading)}, concepts ${pct(sum.conceptMisleading)}
${sum.pass ? "PASS" : "FAIL"}: concepts must win or tie half and help no less. Cost $${(spent / 1e6).toFixed(2)}. Results in ${out}`);
await src.close();
