/**
 * Finds a repo's past pi, Claude Code and Codex transcripts on this machine and
 * splits them into pieces for `impression backfill`.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { transcriptText } from "./session-end.js";

export const BACKFILL_AGENTS = ["pi", "claude", "codex"] as const;
export type BackfillAgent = (typeof BACKFILL_AGENTS)[number];

/** How a person knows each agent. */
export const AGENT_NAMES: Record<BackfillAgent, string> = {
  pi: "pi",
  claude: "Claude Code",
  codex: "Codex",
};

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

/** Where each agent keeps its transcripts. The environment can point elsewhere, for tests. */
export function defaultRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Roots {
  return {
    pi:
      env.IMPRESSION_BACKFILL_PI_DIR ?? join(home, ".pi", "agent", "sessions"),
    claude:
      env.IMPRESSION_BACKFILL_CLAUDE_DIR ?? join(home, ".claude", "projects"),
    codex:
      env.IMPRESSION_BACKFILL_CODEX_DIR ?? join(home, ".codex", "sessions"),
  };
}

export interface SessionFile {
  agent: BackfillAgent;
  path: string;
  /** Where the agent ran, when the file says. */
  cwd?: string;
  /** The agent's session id, sent as `sessionKey`. */
  sessionKey?: string;
  /** First timestamp in the file, else its mtime (ms). */
  start: number;
  /** When the file last changed (ms). */
  mtime: number;
}

/** True when `dir` is `repo` or somewhere under it. Either slash separates. */
export function isUnder(dir: string, repo: string): boolean {
  const d = dir.replaceAll("\\", "/");
  const r = repo.replaceAll("\\", "/").replace(/\/+$/, "");
  return d === r || d.startsWith(`${r}/`);
}

/**
 * The git top level of `dir`, or of its nearest existing ancestor when `dir`
 * is gone. Undefined outside any repo.
 */
export function gitTopLevel(dir: string): string | undefined {
  let d = resolve(dir);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  try {
    return (
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: d,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** pi's session dir name: `/a/b.c` becomes `--a-b.c--`, `C:\a` becomes `--C--a--`. */
export function piDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Claude Code's project dir name: `/a/b.c` becomes `-a-b-c`, `C:\a` becomes `C--a`. */
export function claudeDirName(cwd: string): string {
  return cwd.replace(/[/\\:.]/g, "-");
}

/**
 * Complete JSON lines from the start of a file, up to a byte cap, or null when
 * the file can't be read.
 */
function headEntries(path: string, maxBytes = HEAD_BYTES): unknown[] | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
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
  } catch {
    return null;
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

function startOf(entries: unknown[], mtime: number): number {
  const ts = Date.parse(field(entries, "timestamp") ?? "");
  return Number.isNaN(ts) ? mtime : ts;
}

/** The entry's stats, following links, or null for a dangling or unreadable one. */
function statOf(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Which files to read, by when they last changed. */
interface Window {
  /** Files changed before this are left unread: a session that started after it was written to after it too. */
  since: number;
  /** Files changed after this may belong to a running session and are left unread. */
  until: number;
  /** Where files left unread for `until` are collected, when the caller counts them. */
  running?: Set<string>;
}

function jsonlFiles(dir: string, w: Window): [string, number][] {
  return listDir(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .flatMap((f): [string, number][] => {
      const s = statOf(f);
      if (!s?.isFile() || s.mtimeMs < w.since) return [];
      if (s.mtimeMs > w.until) {
        w.running?.add(f);
        return [];
      }
      return [[f, s.mtimeMs]];
    });
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
  w: Window,
): SessionFile[] {
  const exact = agent === "pi" ? piDirName(repo) : claudeDirName(repo);
  const prefix = agent === "pi" ? exact.slice(0, -2) : exact;
  const out: SessionFile[] = [];
  for (const name of listDir(root)) {
    const nested =
      agent === "pi"
        ? name.startsWith(`${prefix}-`) && name.endsWith("--")
        : name.startsWith(`${prefix}-`);
    if (name !== exact && !nested) continue;
    // Only top-level files: Claude keeps subagent transcripts in subfolders.
    for (const [path, mtime] of jsonlFiles(join(root, name), w)) {
      const head = headEntries(path);
      if (!head) continue;
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
        start: startOf(head, mtime),
        mtime,
      });
    }
  }
  return out;
}

/**
 * Codex rollouts in the window. One changed after `until` is left unread and
 * uncounted: only its contents say which repo it ran in.
 */
function walk(dir: string, w: Window, out: [string, number][] = []) {
  for (const name of listDir(dir)) {
    const p = join(dir, name);
    const s = statOf(p);
    if (!s) continue;
    if (s.isDirectory()) walk(p, w, out);
    else if (
      /^rollout-.*\.jsonl$/.test(name) &&
      s.mtimeMs >= w.since &&
      s.mtimeMs <= w.until
    )
      out.push([p, s.mtimeMs]);
  }
  return out;
}

/** Codex rollouts whose `session_meta` cwd is the repo or under it. */
function codexSessions(files: [string, number][], repo: string): SessionFile[] {
  const out: SessionFile[] = [];
  for (const [path, mtime] of files) {
    const head = headEntries(path);
    if (!head) continue;
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
      start: startOf(head, mtime),
      mtime,
    });
  }
  return out;
}

/**
 * Every transcript run in any of `dirs` (a repo's main checkout and its
 * worktrees) or under them, from the chosen agents, oldest first. A file
 * changed after `settledBefore` is never opened; pi and Claude Code files in
 * the repo's folders are added to `running` instead.
 */
export function discoverSessions(
  dirs: string | readonly string[],
  opts: {
    agents?: readonly BackfillAgent[];
    roots?: Roots;
    since?: number;
    settledBefore?: number;
    running?: Set<string>;
  } = {},
): SessionFile[] {
  const roots = opts.roots ?? defaultRoots();
  const agents = opts.agents ?? BACKFILL_AGENTS;
  const since = opts.since ?? Number.NEGATIVE_INFINITY;
  const found = new Map<string, SessionFile>();
  const add = (list: SessionFile[]) => {
    for (const s of list) found.set(s.path, s);
  };
  const w: Window = {
    since,
    until: opts.settledBefore ?? Number.POSITIVE_INFINITY,
    ...(opts.running ? { running: opts.running } : {}),
  };
  const codexFiles = agents.includes("codex") ? walk(roots.codex, w) : [];
  for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
    const r = resolve(dir);
    if (agents.includes("pi")) add(byDirName("pi", roots.pi, r, w));
    if (agents.includes("claude")) add(byDirName("claude", roots.claude, r, w));
    if (agents.includes("codex")) add(codexSessions(codexFiles, r));
  }
  // A session in another git repo nested under these dirs belongs to that repo.
  const ours = new Set(
    (typeof dirs === "string" ? [dirs] : dirs).map((d) => real(resolve(d))),
  );
  const tops = new Map<string, string | undefined>();
  const inOtherRepo = (cwd: string) => {
    if (!tops.has(cwd)) tops.set(cwd, gitTopLevel(cwd));
    const top = tops.get(cwd);
    if (top === undefined) return false;
    const t = real(top);
    return !ours.has(t) && [...ours].some((d) => isUnder(t, d));
  };
  return [...found.values()]
    .filter((s) => s.start >= since)
    .filter((s) => !s.cwd || !inOtherRepo(s.cwd))
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

/** A session's pieces, read now. */
export function sessionChunks(session: SessionFile): Chunk[] {
  return chunkTranscript(readFileSync(session.path, "utf8"));
}
