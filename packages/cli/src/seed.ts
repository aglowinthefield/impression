/**
 * Dev tool: seeds an Impression server from old local agent transcripts for one
 * repo, oldest first, the way the pi extension sends a live session in pieces.
 * Not an `impression` subcommand; run it with `pnpm --filter @impression/cli seed`.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type ApiClient, createClient, loadConfig } from "@impression/shared";
import { sessionAgent } from "./hook-io.js";
import { transcriptText, uploadSession } from "./session-end.js";

export const SEED_AGENTS = ["pi", "claude", "codex"] as const;
export type SeedAgent = (typeof SEED_AGENTS)[number];

/** Just under the 60k characters extraction reads from the end of a transcript. */
export const CHUNK_CHARS = 55_000;
/** Chunks with less conversation than this aren't worth an extraction call. */
export const MIN_CHUNK_CHARS = 500;
/** How much of a file to read when looking for its cwd and start time. */
const HEAD_BYTES = 1_000_000;

export interface Roots {
  pi: string;
  claude: string;
  codex: string;
}

export function defaultRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Roots {
  return {
    pi: env.IMPRESSION_SEED_PI_DIR ?? join(home, ".pi", "agent", "sessions"),
    claude: env.IMPRESSION_SEED_CLAUDE_DIR ?? join(home, ".claude", "projects"),
    codex: env.IMPRESSION_SEED_CODEX_DIR ?? join(home, ".codex", "sessions"),
  };
}

export interface SeedSession {
  agent: SeedAgent;
  path: string;
  /** Where the agent ran, when the file says. */
  cwd?: string;
  /** The agent's session id, sent as `sessionKey`. */
  sessionKey?: string;
  /** First timestamp in the file, else its mtime (ms). */
  start: number;
}

/** True when `dir` is `repo` or somewhere under it. */
export function isUnder(dir: string, repo: string): boolean {
  const r = repo.replace(/\/+$/, "");
  return dir === r || dir.startsWith(`${r}/`);
}

/** pi's session dir name: `/a/b.c` becomes `--a-b.c--`. */
export function piDirName(cwd: string): string {
  return `--${cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`;
}

/** Claude Code's project dir name: `/a/b.c` becomes `-a-b-c`. */
export function claudeDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Complete JSON lines from the start of a file, up to a byte cap. */
function headEntries(path: string, maxBytes = HEAD_BYTES): unknown[] {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(maxBytes, statSync(path).size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const out: unknown[] = [];
    for (const line of text.split("\n")) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** First string at `key` on an entry or its payload. */
function field(entries: unknown[], key: string): string | undefined {
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const rec = e as Record<string, unknown>;
    const v = rec[key] ?? (rec.payload as Record<string, unknown>)?.[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function startOf(entries: unknown[], path: string): number {
  const ts = Date.parse(field(entries, "timestamp") ?? "");
  return Number.isNaN(ts) ? statSync(path).mtimeMs : ts;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function jsonlFiles(dir: string): string[] {
  return listDir(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

/**
 * Sessions from dirs named after the repo or a path under it. The names are
 * lossy (`-` stands for `/`), so a file's own cwd decides when it has one;
 * a file without one counts only in the repo's exact dir.
 */
function byDirName(
  agent: "pi" | "claude",
  root: string,
  repo: string,
): SeedSession[] {
  const exact = agent === "pi" ? piDirName(repo) : claudeDirName(repo);
  const prefix = agent === "pi" ? exact.slice(0, -2) : exact;
  const out: SeedSession[] = [];
  for (const name of listDir(root)) {
    const nested =
      agent === "pi"
        ? name.startsWith(`${prefix}-`) && name.endsWith("--")
        : name.startsWith(`${prefix}-`);
    if (name !== exact && !nested) continue;
    // Only top-level files: Claude keeps subagent transcripts in subfolders.
    for (const path of jsonlFiles(join(root, name))) {
      const head = headEntries(path);
      const cwd = field(head, "cwd");
      if (cwd ? !isUnder(cwd, repo) : name !== exact) continue;
      const sessionKey =
        agent === "pi"
          ? (head[0] as { type?: string; id?: string } | undefined)?.type ===
            "session"
            ? (head[0] as { id?: string }).id
            : undefined
          : (field(head, "sessionId") ?? basename(path, ".jsonl"));
      out.push({
        agent,
        path,
        ...(cwd ? { cwd } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        start: startOf(head, path),
      });
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of listDir(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/^rollout-.*\.jsonl$/.test(name)) out.push(p);
  }
  return out;
}

/** Codex rollouts whose `session_meta` cwd is the repo or under it. */
function codexSessions(root: string, repo: string): SeedSession[] {
  const out: SeedSession[] = [];
  for (const path of walk(root)) {
    const head = headEntries(path);
    const meta = head.find(
      (e) => (e as { type?: string })?.type === "session_meta",
    ) as { payload?: { cwd?: unknown; id?: unknown } } | undefined;
    const cwd = meta?.payload?.cwd;
    if (typeof cwd !== "string" || !isUnder(cwd, repo)) continue;
    const id = meta?.payload?.id;
    out.push({
      agent: "codex",
      path,
      cwd,
      ...(typeof id === "string" && id ? { sessionKey: id } : {}),
      start: startOf(head, path),
    });
  }
  return out;
}

/** Every transcript for the repo from the chosen agents, oldest first. */
export function discoverSessions(
  repo: string,
  opts: { agents?: readonly SeedAgent[]; roots?: Roots; since?: number } = {},
): SeedSession[] {
  const roots = opts.roots ?? defaultRoots();
  const agents = opts.agents ?? SEED_AGENTS;
  const r = resolve(repo);
  const found: SeedSession[] = [];
  if (agents.includes("pi")) found.push(...byDirName("pi", roots.pi, r));
  if (agents.includes("claude"))
    found.push(...byDirName("claude", roots.claude, r));
  if (agents.includes("codex")) found.push(...codexSessions(roots.codex, r));
  return found
    .filter((s) => opts.since === undefined || s.start >= opts.since)
    .sort((a, b) => a.start - b.start || a.path.localeCompare(b.path));
}

export interface Chunk {
  /** Whole JSONL lines, as the hooks would send them. */
  raw: string;
  /** Length of the chunk's conversation text. */
  chars: number;
}

/**
 * Splits a JSONL transcript on whole lines so each piece's conversation text
 * stays within `max`. A single line bigger than that becomes its own piece.
 * Pieces with less than `min` characters of text are dropped.
 */
export function chunkTranscript(
  raw: string,
  max = CHUNK_CHARS,
  min = MIN_CHUNK_CHARS,
): Chunk[] {
  const out: Chunk[] = [];
  let lines: string[] = [];
  let chars = 0;
  const flush = () => {
    if (lines.length) {
      const piece = lines.join("\n");
      const n = transcriptText(piece).length;
      if (n >= min) out.push({ raw: piece, chars: n });
    }
    lines = [];
    chars = 0;
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const n = transcriptText(line).length;
    // Turns are joined with a blank line.
    const add = n && chars ? n + 2 : n;
    if (chars && chars + add > max) flush();
    lines.push(line);
    chars += add;
  }
  flush();
  return out;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Throws unless the URL points at this machine, or remote is allowed. */
export function assertLocal(url: string, allowRemote = false): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (!allowRemote && !LOCAL_HOSTS.has(host))
    throw new Error(
      `refusing to seed ${url}: not localhost (pass --allow-remote to override)`,
    );
}

/** Network errors, timeouts and 5xx replies are worth another try; 4xx are not. */
export function retryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const api = /^Impression API (\d+)/.exec(msg);
  return api ? Number(api[1]) >= 500 : true;
}

/** A fetch that gives up after `ms`. */
export function timedFetch(
  ms: number,
  base: typeof fetch = fetch,
): typeof fetch {
  return (input, init) =>
    base(input, { ...init, signal: AbortSignal.timeout(ms) });
}

export interface SeedItem {
  session: SeedSession;
  /** 1-based piece number within the session. */
  part: number;
  chunk: Chunk;
}

export interface SeedTotals {
  chunks: number;
  uploaded: number;
  duplicates: number;
  failed: number;
  memories: number;
}

export interface SeedOptions {
  repo: string;
  concurrency?: number;
  retries?: number;
  log?: (line: string) => void;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function label(item: SeedItem): string {
  const s = item.session;
  return `${s.agent} ${day(s.start)} ${basename(s.path)}#${item.part}`;
}

/** Splits sessions into upload items, keeping session order. */
export function seedItems(sessions: SeedSession[]): SeedItem[] {
  return sessions.flatMap((session) =>
    chunkTranscript(readFileSync(session.path, "utf8")).map((chunk, i) => ({
      session,
      part: i + 1,
      chunk,
    })),
  );
}

/**
 * Uploads each item with extraction, a few at a time in order. A failing item
 * is retried on network and 5xx errors, then counted; it never stops the run.
 */
export async function seed(
  client: ApiClient,
  items: SeedItem[],
  opts: SeedOptions,
): Promise<SeedTotals> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const retries = opts.retries ?? 2;
  const totals: SeedTotals = {
    chunks: items.length,
    uploaded: 0,
    duplicates: 0,
    failed: 0,
    memories: 0,
  };
  const width = String(items.length).length;
  let next = 0;
  const one = async (i: number) => {
    const item = items[i] as SeedItem;
    const tag = `[${String(i + 1).padStart(width)}/${items.length}] ${label(item)}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await uploadSession(
          client,
          {
            raw: item.chunk.raw,
            cwd: opts.repo,
            ...(item.session.sessionKey
              ? { sessionKey: item.session.sessionKey }
              : {}),
          },
          {
            extract: true,
            agent: sessionAgent(item.session.agent),
            // A retry may follow a reply that got lost after the server stored the chunk.
            extractDuplicate: attempt > 0,
          },
        );
        if (!res) {
          log(`${tag} empty`);
          return;
        }
        if (res.duplicate) totals.duplicates++;
        else totals.uploaded++;
        const x = res.extracted;
        if (!x) {
          log(`${tag} dup`);
          return;
        }
        const accepted = x.accepted ?? 0;
        const skipped =
          (x.skippedDuplicates ?? 0) +
          (x.skippedEmpty ?? 0) +
          (x.skippedRepeats ?? 0) +
          (x.skippedBelowFloor ?? 0) +
          (x.skippedNoAccess ?? 0);
        totals.memories += accepted;
        log(
          `${tag} extracted ${accepted} skipped ${skipped}${res.duplicate ? " (dup)" : ""}`,
        );
        return;
      } catch (err) {
        lastErr = err;
        if (!retryable(err)) break;
      }
    }
    totals.failed++;
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    log(`${tag} failed ${msg.replace(/\s+/g, " ").slice(0, 200)}`);
  };
  const worker = async () => {
    while (next < items.length) await one(next++);
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(opts.concurrency ?? 3, items.length)) },
      worker,
    ),
  );
  log(
    `done: chunks ${totals.chunks} uploaded ${totals.uploaded} duplicates ${totals.duplicates} failed ${totals.failed} memories ${totals.memories}`,
  );
  return totals;
}

const USAGE = `usage: pnpm --filter @impression/cli seed -- --repo <path> [--agents pi,claude,codex]
  [--since YYYY-MM-DD] [--limit N] [--concurrency 3] [--timeout 180] [--dry-run]
  [--url http://localhost:3000] [--token imp_...] [--allow-remote]`;

/** The `seed` script. Returns the exit code. */
export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv,
    options: {
      repo: { type: "string" },
      agents: { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      timeout: { type: "string" },
      "dry-run": { type: "boolean" },
      url: { type: "string" },
      token: { type: "string" },
      "allow-remote": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.repo) {
    log(USAGE);
    return values.help ? 0 : 1;
  }
  const repo = resolve(values.repo);
  if (!existsSync(join(repo, ".git")))
    throw new Error(`not a git checkout: ${repo}`);
  const agents = (values.agents ?? SEED_AGENTS.join(","))
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  for (const a of agents)
    if (!SEED_AGENTS.includes(a as SeedAgent))
      throw new Error(
        `unknown agent: ${a} (pick from ${SEED_AGENTS.join(",")})`,
      );
  const since = values.since ? Date.parse(values.since) : undefined;
  if (since !== undefined && Number.isNaN(since))
    throw new Error(`bad --since: ${values.since}`);
  const num = (v: string | undefined, name: string, dflt: number) => {
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`bad --${name}: ${v}`);
    return n;
  };
  const limit = num(values.limit, "limit", Number.POSITIVE_INFINITY);
  const concurrency = num(values.concurrency, "concurrency", 3);
  const timeoutMs = num(values.timeout, "timeout", 180) * 1000;

  // URL and token: flags, then IMPRESSION_URL / IMPRESSION_TOKEN, then saved config.
  const config = loadConfig(env);
  const url = values.url ?? config.url;
  const token = values.token ?? config.token;
  // A dry run sends nothing, so it may name any server.
  if (!values["dry-run"]) assertLocal(url, values["allow-remote"] === true);

  const sessions = discoverSessions(repo, {
    agents: agents as SeedAgent[],
    roots: defaultRoots(env),
    ...(since !== undefined ? { since } : {}),
  }).slice(0, limit);
  const items = seedItems(sessions);

  if (values["dry-run"]) {
    const per = new Map<
      string,
      { sessions: number; chunks: number; chars: number }
    >();
    for (const s of sessions) {
      const mine = items.filter((i) => i.session === s);
      const chars = mine.reduce((n, i) => n + i.chunk.chars, 0);
      log(
        `${s.agent} ${day(s.start)} ${s.path} chunks ${mine.length} chars ${chars}`,
      );
      const t = per.get(s.agent) ?? { sessions: 0, chunks: 0, chars: 0 };
      per.set(s.agent, {
        sessions: t.sessions + 1,
        chunks: t.chunks + mine.length,
        chars: t.chars + chars,
      });
    }
    for (const [agent, t] of per)
      log(
        `total ${agent}: sessions ${t.sessions} chunks ${t.chunks} chars ${t.chars}`,
      );
    log(
      `total: sessions ${sessions.length} chunks ${items.length} chars ${items.reduce((n, i) => n + i.chunk.chars, 0)} (dry run, nothing sent to ${url})`,
    );
    return 0;
  }

  if (!token) throw new Error("no token: pass --token or set IMPRESSION_TOKEN");
  const client = createClient(url, token, timedFetch(timeoutMs));
  log(`seeding ${url}: ${sessions.length} sessions, ${items.length} chunks`);
  const totals = await seed(client, items, { repo, concurrency, log });
  return totals.failed ? 1 : 0;
}
