/**
 * `impression backfill`: extracts memories from a repo's past agent sessions.
 * The server decides what costs money (model, prices, budget) and which pieces
 * it has already extracted; this side finds the sessions, asks for a plan,
 * and sends the new pieces oldest first, three at a time.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  type ApiClient,
  configPath,
  pieceHash,
  resolveProject,
} from "@impression/shared";
import { commitBefore } from "./candidates.js";
import { sessionAgent } from "./hook-io.js";
import { safeCandidates, transcriptText } from "./session-end.js";
import {
  AGENT_NAMES,
  BACKFILL_AGENTS,
  type BackfillAgent,
  defaultRoots,
  discoverSessions,
  type SessionFile,
  sessionChunks,
} from "./transcripts.js";

const DAY_MS = 86_400_000;
/** The default window: sessions that started in the last 30 days... */
export const DEFAULT_DAYS = 30;
/** ...at most this many, newest kept. */
export const DEFAULT_LIMIT = 50;
/** A transcript changed more recently than this may belong to a running session. */
export const RUNNING_MS = 60 * 60_000;
/** Pieces in flight at once. */
export const CONCURRENCY = 3;
/** Pieces per plan request; the server takes up to 5000. */
const PLAN_BATCH = 1000;

export const NOT_SIGNED_IN = "Not signed in. Run: impression login --github";

export { commitBefore };

/** Dollars as whole millionths, so sums and comparisons are exact. */
const micros = (usd: number) => Math.round(usd * 1e6);

// ---------------------------------------------------------------- repo

export interface Repo {
  /** The checkout the command runs in: its HEAD anchors the memories. */
  checkout: string;
  /** The main checkout and every worktree, where sessions may have run. */
  dirs: string[];
  /** The project key and name, resolved as the hooks resolve them. */
  key: string;
  name: string;
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** The git repo `cwd` is in, or null outside one. */
export function findRepo(cwd: string): Repo | null {
  const checkout = git(cwd, "rev-parse", "--show-toplevel");
  if (!checkout) return null;
  const dirs = new Set<string>([checkout]);
  // Each worktree's own top level: with a separate git dir, git lists the git
  // dir as the main worktree, and that has no top level, so it's left out.
  for (const line of (
    git(checkout, "worktree", "list", "--porcelain") ?? ""
  ).split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const top = git(line.slice(9), "rev-parse", "--show-toplevel");
    if (top) dirs.add(top);
  }
  const p = resolveProject(checkout);
  return { checkout, dirs: [...dirs], key: p.key, name: p.name };
}

// ---------------------------------------------------------------- lock and progress

const projectHash = (key: string) =>
  createHash("sha256").update(key).digest("hex").slice(0, 16);

export const backfillDir = (env: NodeJS.ProcessEnv = process.env) =>
  join(dirname(configPath(env)), "backfill");

const lockPath = (env: NodeJS.ProcessEnv, key: string) =>
  join(backfillDir(env), `${projectHash(key)}.lock`);
export const progressPath = (env: NodeJS.ProcessEnv, key: string) =>
  join(backfillDir(env), `${projectHash(key)}.json`);

/** Whether a process with this id is running. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When the process with this id started, in clock ticks since boot, from
 * Linux's `/proc/<pid>/stat`; undefined where there is no `/proc`. A reused
 * pid has a different start time, so it can't pass for the lock's holder.
 */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22; the command name before it is in parentheses and may hold spaces.
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return start && /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the lock's holder is still running: its pid is alive and, when the
 * lock and the system both know start times, the process at that pid started
 * when the holder did. Elsewhere only the pid is checked.
 */
export function holderAlive(pid: number, start?: string): boolean {
  if (!pidAlive(pid)) return false;
  if (start === undefined) return true;
  const now = processStart(pid);
  return now === undefined || now === start;
}

/** Tells whether the process that took a lock, by pid and start time, still runs. */
export type Alive = (pid: number, start?: string) => boolean;

/** A lock's holder: `<pid>` or `<pid> <start time>`. */
function parseLock(text: string): { pid: number; start?: string } | undefined {
  const [p, start] = text.trim().split(/\s+/);
  const pid = Number(p);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return start ? { pid, start } : { pid };
}

/** The pid holding the repo's lock, if that process is still running. */
export function lockHolder(
  env: NodeJS.ProcessEnv,
  key: string,
  alive: Alive = holderAlive,
): number | undefined {
  try {
    const h = parseLock(readFileSync(lockPath(env, key), "utf8"));
    return h && alive(h.pid, h.start) ? h.pid : undefined;
  } catch {
    return undefined;
  }
}

/** A lock file's text and identity, read through one descriptor. */
function readLockFile(path: string): { text: string; ino: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    return { text: readFileSync(fd, "utf8"), ino: fstatSync(fd).ino };
  } finally {
    closeSync(fd);
  }
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * Takes the repo's lock for `pid`, noting the process's start time where the
 * system tells it. False when a running process holds it. A lock whose process
 * is gone (a crash, Ctrl-C, a closed terminal), or whose pid now belongs to a
 * process that started at another time, is taken over.
 *
 * The lock is written whole under a unique name and hard-linked into place, an
 * exclusive create, so no one reads a half-written lock. A stale lock is moved
 * aside under a unique name, which only one contender can do, and removed only
 * when the moved file is the one found stale; a live lock moved by mistake is
 * put back. `onStale` runs between finding a lock stale and moving it, for tests.
 */
export function acquireLock(
  env: NodeJS.ProcessEnv,
  key: string,
  pid: number,
  alive: Alive = holderAlive,
  onStale?: () => void,
): boolean {
  const path = lockPath(env, key);
  mkdirSync(dirname(path), { recursive: true });
  const mine = `${path}.${pid}.${randomUUID()}.new`;
  const start = processStart(pid);
  writeFileSync(mine, `${pid}${start ? ` ${start}` : ""}\n`);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(mine, path);
        return true;
      } catch (e) {
        if (errCode(e) !== "EEXIST") throw e;
      }
      const held = readLockFile(path);
      if (!held) continue;
      const holder = parseLock(held.text);
      if (holder && alive(holder.pid, holder.start)) return false;
      onStale?.();
      const aside = `${path}.${pid}.${randomUUID()}.stale`;
      try {
        renameSync(path, aside);
      } catch (e) {
        if (errCode(e) === "ENOENT") continue;
        throw e;
      }
      const moved = readLockFile(aside);
      if (moved?.ino !== held.ino || moved.text !== held.text) {
        // Another contender's lock, taken after this one read the stale one.
        try {
          linkSync(aside, path);
        } catch {}
      }
      rmSync(aside, { force: true });
    }
    return false;
  } finally {
    rmSync(mine, { force: true });
  }
}

export function releaseLock(env: NodeJS.ProcessEnv, key: string, pid: number) {
  try {
    const path = lockPath(env, key);
    if (parseLock(readFileSync(path, "utf8"))?.pid === pid) rmSync(path);
  } catch {}
}

export interface Progress {
  total: number;
  done: number;
  saved: number;
  updated: number;
  failed: number;
  notSent: number;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
}

function writeProgress(env: NodeJS.ProcessEnv, key: string, p: Progress) {
  try {
    const path = progressPath(env, key);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(p)}\n`);
    renameSync(tmp, path);
  } catch {}
}

export function readProgress(
  env: NodeJS.ProcessEnv,
  key: string,
): Progress | null {
  try {
    return JSON.parse(readFileSync(progressPath(env, key), "utf8")) as Progress;
  } catch {
    return null;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The backfill line for `impression status`: progress while a backfill runs in
 * the repo, then once after it finishes or stops. Call `clear` once the line
 * is printed: it removes a finished or stopped run's progress, and only the
 * run shown, since a new run may have started since it was read.
 */
export function backfillStatus(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  alive: Alive = holderAlive,
): { text: string; clear: () => void } | undefined {
  const key = resolveProject(cwd).key;
  const p = readProgress(env, key);
  if (!p) return undefined;
  const memories = `${plural(p.saved, "memory", "memories")} saved${p.updated ? `, ${p.updated} updated` : ""}`;
  const failed = p.failed ? `, ${p.failed} failed` : "";
  if (!p.finishedAt && lockHolder(env, key, alive) !== undefined)
    return {
      text: `Backfill:  running, ${p.done} of ${p.total} pieces done, ${memories}${failed}`,
      clear: () => {},
    };
  const clear = () => {
    const now = readProgress(env, key);
    if (now?.startedAt === p.startedAt && now.finishedAt === p.finishedAt)
      rmSync(progressPath(env, key), { force: true });
  };
  if (!p.finishedAt)
    return {
      text: `Backfill:  stopped at ${p.done} of ${p.total} pieces, ${memories}. Run impression backfill to send the rest.`,
      clear,
    };
  return {
    text: `Backfill:  finished, ${p.done} of ${p.total} pieces, ${memories}${failed}, ${usd(p.costUsd)}`,
    clear,
  };
}

// ---------------------------------------------------------------- plan

export interface Piece {
  session: SessionFile;
  /** 1-based piece number within the session. */
  part: number;
  raw: string;
  /** The conversation text sent as the transcript. */
  transcript: string;
  hash: string;
}

/** Each session's pieces, in session order. A piece seen twice is kept once. */
export function toPieces(sessions: SessionFile[]): Piece[] {
  const seen = new Set<string>();
  const out: Piece[] = [];
  for (const session of sessions) {
    let part = 0;
    for (const chunk of sessionChunks(session)) {
      part++;
      const transcript = transcriptText(chunk.raw);
      // Hashed as the server hashes what it receives, so the plan can match it.
      const hash = pieceHash(transcript);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({ session, part, raw: chunk.raw, transcript, hash });
    }
  }
  return out;
}

interface PlanReply {
  pieces: { hash: string; status: "new" | "done" | "live" }[];
  estimateUsd: number;
  budgetUsd: number;
  spentUsd: number;
  model: string;
}

/** POST /backfill/plan, in batches the server takes. */
async function askPlan(
  client: ApiClient,
  key: string,
  pieces: Piece[],
): Promise<PlanReply> {
  const out: PlanReply = {
    pieces: [],
    estimateUsd: 0,
    budgetUsd: 0,
    spentUsd: 0,
    model: "",
  };
  for (let i = 0; i === 0 || i < pieces.length; i += PLAN_BATCH) {
    const r = (await client.post("/backfill/plan", {
      project: key,
      pieces: pieces.slice(i, i + PLAN_BATCH).map((p) => ({
        ...(p.session.sessionKey ? { sessionKey: p.session.sessionKey } : {}),
        hash: p.hash,
        chars: p.transcript.length,
      })),
    })) as PlanReply;
    out.pieces.push(...r.pieces);
    out.estimateUsd += r.estimateUsd;
    out.budgetUsd = r.budgetUsd;
    out.spentUsd = r.spentUsd;
    out.model = r.model;
  }
  return out;
}

export interface Plan {
  repo: Repo;
  /** Pieces to send, oldest first. */
  send: Piece[];
  estimateUsd: number;
  /** New pieces the budget leaves out, the newest ones. */
  leftOut: number;
  /** Sessions with a new piece, the left-out ones included. */
  newSessions: number;
  /** Estimate of every new piece, the left-out ones included. */
  fullEstimateUsd: number;
  budgetUsd: number;
  spentUsd: number;
  model: string;
  skipped: { live: number; running: number; done: number };
}

export interface PlanOptions {
  agents?: readonly BackfillAgent[];
  since?: number;
  limit?: number;
}

/**
 * Finds the repo's sessions in the window, splits them and asks the server
 * which pieces are new and what they cost. When the estimate passes what is
 * left of the budget, keeps the oldest pieces that fit, priced by the server.
 */
export async function makePlan(
  client: ApiClient,
  repo: Repo,
  opts: PlanOptions,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<Plan> {
  const since = opts.since ?? now - DEFAULT_DAYS * DAY_MS;
  const running = new Set<string>();
  const settled = discoverSessions(repo.dirs, {
    agents: opts.agents ?? BACKFILL_AGENTS,
    roots: defaultRoots(env),
    since,
    settledBefore: now - RUNNING_MS,
    running,
  });
  const window = settled.slice(-(opts.limit ?? DEFAULT_LIMIT));
  const pieces = toPieces(window);
  const reply = await askPlan(client, repo.key, pieces);
  const status = new Map(reply.pieces.map((p) => [p.hash, p.status]));
  const fresh = pieces.filter((p) => status.get(p.hash) === "new");
  const liveSessions = new Set(
    pieces
      .filter((p) => status.get(p.hash) === "live")
      .map((p) => p.session.path),
  );
  const left = Math.max(0, micros(reply.budgetUsd) - micros(reply.spentUsd));
  let send = fresh;
  let estimateUsd = reply.estimateUsd;
  if (fresh.length && micros(reply.estimateUsd) > left) {
    // The longest oldest-first prefix whose estimate fits, by bisection on the
    // server's own prices. Estimates grow with every piece added.
    let fit = 0;
    estimateUsd = 0;
    let lo = 1;
    let hi = left > 0 ? fresh.length - 1 : 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const est = (await askPlan(client, repo.key, fresh.slice(0, mid)))
        .estimateUsd;
      if (micros(est) <= left) {
        fit = mid;
        estimateUsd = est;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    send = fresh.slice(0, fit);
  }
  return {
    repo,
    send,
    estimateUsd,
    leftOut: fresh.length - send.length,
    newSessions: new Set(fresh.map((p) => p.session.path)).size,
    fullEstimateUsd: reply.estimateUsd,
    budgetUsd: reply.budgetUsd,
    spentUsd: reply.spentUsd,
    model: reply.model,
    skipped: {
      live: liveSessions.size,
      running: running.size,
      done: pieces.filter((p) => status.get(p.hash) === "done").length,
    },
  };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const when = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Where a session ran, relative to the repo, when it wasn't the checkout root. */
function where(s: SessionFile, repo: Repo): string {
  if (!s.cwd) return "";
  for (const dir of repo.dirs) {
    const rel = relative(dir, s.cwd).replaceAll("\\", "/");
    if (!rel.startsWith("..")) return rel;
  }
  return s.cwd;
}

/** The plan as a person reads it: sessions per agent, counts, cost and budget. */
export function formatPlan(plan: Plan): string[] {
  const out = [`Backfill for ${plan.repo.key}`];
  const sessions = new Set(plan.send.map((p) => p.session));
  for (const agent of BACKFILL_AGENTS) {
    const mine = [...sessions].filter((s) => s.agent === agent);
    if (!mine.length) continue;
    out.push("", `${AGENT_NAMES[agent]}: ${plural(mine.length, "session")}`);
    for (const s of mine) {
      const n = plan.send.filter((p) => p.session === s).length;
      const at = where(s, plan.repo);
      out.push(
        `  ${when(s.start)}  ${plural(n, "piece")}${at ? `  ${at}` : ""}`,
      );
    }
  }
  const left = Math.max(0, plan.budgetUsd - plan.spentUsd);
  out.push("");
  if (plan.send.length)
    out.push(
      `${plural(sessions.size, "session")}, ${plural(plan.send.length, "piece")}. Estimated cost ${usd(plan.estimateUsd)} on ${plan.model}.`,
    );
  else
    out.push(
      `${plural(plan.newSessions, "session")}, ${plural(plan.leftOut, "piece")}. Estimated cost ${usd(plan.fullEstimateUsd)} on ${plan.model}.`,
    );
  out.push(`Backfill budget left: ${usd(left)} of ${usd(plan.budgetUsd)}.`);
  if (plan.leftOut)
    out.push(
      `All ${plan.send.length + plan.leftOut} new pieces would cost about ${usd(plan.fullEstimateUsd)}, more than is left: the ${plural(plan.leftOut, "newest piece")} ${plan.leftOut === 1 ? "is" : "are"} left out.`,
    );
  const skipped = skipLine(plan);
  if (skipped) out.push(skipped);
  return out;
}

/** What the plan leaves out and why, or undefined when nothing. */
function skipLine(plan: Plan): string | undefined {
  const skips = [
    plan.skipped.live &&
      `${plural(plan.skipped.live, "session")} the hooks already sent`,
    plan.skipped.running &&
      `${plural(plan.skipped.running, "session")} changed in the last hour (may still be running)`,
    plan.skipped.done &&
      `${plural(plan.skipped.done, "piece")} already extracted`,
  ].filter(Boolean);
  return skips.length ? `Skipped: ${skips.join(", ")}.` : undefined;
}

// ---------------------------------------------------------------- run

/** The HTTP status in an API error, if it is one. */
function apiStatus(err: unknown): number | undefined {
  const m = /^Impression API (\d+)/.exec(
    err instanceof Error ? err.message : String(err),
  );
  return m ? Number(m[1]) : undefined;
}

/** Network errors, timeouts and 5xx replies are worth another try; 4xx are not. */
export function retryable(err: unknown): boolean {
  const status = apiStatus(err);
  return status === undefined || status >= 500;
}

/** A fetch that gives up after `ms`. */
export function timedFetch(
  ms: number,
  base: typeof fetch = fetch,
): typeof fetch {
  return (input, init) =>
    base(input, { ...init, signal: AbortSignal.timeout(ms) });
}

type Outcome =
  | { kind: "extracted"; saved: number; updated: number; costUsd: number }
  | { kind: "already"; saved: number; updated: number }
  | { kind: "budget" }
  | { kind: "busy" }
  | { kind: "failed"; error: string };

interface Extracted {
  saved?: number;
  updated?: number;
  costUsd?: number;
  alreadyExtracted?: boolean;
}

/**
 * Uploads one piece as a backfill session and extracts it. Throws on API
 * errors. Once `stopped` (the budget ran out meanwhile) it skips the extract.
 */
async function sendPiece(
  client: ApiClient,
  repo: Repo,
  piece: Piece,
  commitSha: string | undefined,
  instructions: string | undefined,
  stopped: () => boolean,
): Promise<Outcome> {
  const s = piece.session;
  // Other repos the session touched are anchored at their commit then, too.
  const candidates = safeCandidates(
    piece.raw,
    s.cwd ?? repo.checkout,
    repo.key,
    s.start,
  );
  const up = (await client.post("/sessions", {
    project: { key: repo.key, name: repo.name },
    ...(candidates.length ? { candidates } : {}),
    transcript: piece.transcript,
    ...(commitSha ? { commitSha } : {}),
    agent: sessionAgent(s.agent),
    ...(s.sessionKey ? { sessionKey: s.sessionKey } : {}),
    source: "backfill",
    startedAt: new Date(s.start).toISOString(),
  })) as { id: string };
  if (stopped()) return { kind: "budget" };
  let x: Extracted;
  try {
    x = ((await client.post(
      `/sessions/${up.id}/extract`,
      instructions ? { instructions } : {},
    )) ?? {}) as Extracted;
  } catch (err) {
    const status = apiStatus(err);
    if (status === 402) return { kind: "budget" };
    if (status === 409) return { kind: "busy" };
    throw err;
  }
  const saved = x.saved ?? 0;
  const updated = x.updated ?? 0;
  return x.alreadyExtracted
    ? { kind: "already", saved, updated }
    : { kind: "extracted", saved, updated, costUsd: x.costUsd ?? 0 };
}

export interface RunTotals {
  total: number;
  done: number;
  saved: number;
  updated: number;
  failed: number;
  /** Pieces left unsent: refused for budget, or extracted by another request at the time. */
  notSent: number;
  budgetStopped: boolean;
  costUsd: number;
  sessions: number;
}

export interface RunOptions {
  log: (line: string) => void;
  onProgress?: (t: RunTotals) => void;
  concurrency?: number;
  instructions?: string;
}

function label(p: Piece): string {
  return `${AGENT_NAMES[p.session.agent]} ${day(p.session.start)} ${basename(p.session.path)}#${p.part}`;
}

/**
 * Sends the plan's pieces oldest first, a few at a time, one line each. A
 * failure is retried once on a network error, timeout or 5xx, then counted and
 * the run goes on. A budget refusal stops the run: pieces in flight finish the
 * request they're in, and none starts another upload, extract or retry.
 */
export async function runPlan(
  client: ApiClient,
  plan: Plan,
  opts: RunOptions,
): Promise<RunTotals> {
  const items = plan.send;
  const totals: RunTotals = {
    total: items.length,
    done: 0,
    saved: 0,
    updated: 0,
    failed: 0,
    notSent: 0,
    budgetStopped: false,
    costUsd: 0,
    sessions: 0,
  };
  const read = new Set<string>();
  const commits = new Map<string, string | undefined>();
  const commitFor = (s: SessionFile) => {
    if (!commits.has(s.path))
      commits.set(s.path, commitBefore(plan.repo.checkout, s.start));
    return commits.get(s.path);
  };
  const width = String(items.length).length;
  let next = 0;

  const one = async (i: number) => {
    const piece = items[i] as Piece;
    read.add(piece.session.path);
    const tag = `[${String(i + 1).padStart(width)}/${items.length}] ${label(piece)}`;
    let outcome: Outcome = { kind: "failed", error: "" };
    for (let attempt = 0; attempt < 2; attempt++) {
      // After a budget refusal nothing new starts, a retry included.
      if (totals.budgetStopped) {
        outcome = { kind: "budget" };
        break;
      }
      try {
        outcome = await sendPiece(
          client,
          plan.repo,
          piece,
          commitFor(piece.session),
          opts.instructions,
          () => totals.budgetStopped,
        );
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = {
          kind: "failed",
          error: msg.replace(/\s+/g, " ").slice(0, 200),
        };
        if (!retryable(err)) break;
      }
    }
    switch (outcome.kind) {
      case "extracted":
      case "already":
        totals.done++;
        totals.saved += outcome.saved;
        totals.updated += outcome.updated;
        if (outcome.kind === "extracted") {
          totals.costUsd += outcome.costUsd;
          opts.log(
            `${tag} saved ${outcome.saved}, updated ${outcome.updated}, ${usd(outcome.costUsd)}`,
          );
        } else opts.log(`${tag} already extracted`);
        break;
      case "budget":
        totals.notSent++;
        totals.budgetStopped = true;
        opts.log(`${tag} not sent: backfill budget used up`);
        break;
      case "busy":
        totals.notSent++;
        opts.log(`${tag} not sent: another run is extracting it`);
        break;
      case "failed":
        totals.failed++;
        opts.log(`${tag} failed: ${outcome.error}`);
        break;
    }
    totals.sessions = read.size;
    opts.onProgress?.(totals);
  };

  const worker = async () => {
    while (!totals.budgetStopped && next < items.length) await one(next++);
  };
  await Promise.all(
    Array.from(
      {
        length: Math.max(
          1,
          Math.min(opts.concurrency ?? CONCURRENCY, items.length),
        ),
      },
      worker,
    ),
  );
  // Pieces never started once the budget ran out.
  totals.notSent += items.length - next;
  return totals;
}

/** The lines that end a run. */
export function formatTotals(t: RunTotals): string[] {
  const out = [
    `Done. Sessions read: ${t.sessions}. Memories saved: ${t.saved}, updated: ${t.updated}. Cost: ${usd(t.costUsd)}.`,
  ];
  if (t.budgetStopped)
    out.push(
      `The backfill budget ran out: ${plural(t.notSent, "piece")} not sent.`,
    );
  else if (t.notSent)
    out.push(
      `${plural(t.notSent, "piece")} not sent: another run was extracting ${t.notSent === 1 ? "it" : "them"}.`,
    );
  if (t.failed)
    out.push(
      `${plural(t.failed, "piece")} failed. The next impression backfill sends ${t.failed === 1 ? "it" : "them"} again.`,
    );
  return out;
}

// ---------------------------------------------------------------- command

export interface BackfillArgs {
  repo?: string;
  since?: number;
  limit?: number;
  agents?: BackfillAgent[];
  yes: boolean;
  dryRun: boolean;
  undo: boolean;
}

/** Parses `impression backfill`'s options. Throws with a message on a bad one. */
export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
      agents: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      undo: { type: "boolean" },
    },
  });
  const out: BackfillArgs = {
    yes: values.yes === true,
    dryRun: values["dry-run"] === true,
    undo: values.undo === true,
  };
  if (values.repo) out.repo = values.repo;
  if (values.since !== undefined) {
    const since = Date.parse(values.since);
    if (Number.isNaN(since))
      throw new Error(`--since takes a date, like 2026-10-01: ${values.since}`);
    out.since = since;
  }
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 1)
      throw new Error(
        `--limit takes a whole number of sessions: ${values.limit}`,
      );
    out.limit = n;
  }
  if (values.agents !== undefined) {
    const list = values.agents
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const bad = list.filter((a) => !BACKFILL_AGENTS.includes(a as never));
    if (!list.length || bad.length)
      throw new Error(
        `--agents takes a comma-separated list of ${BACKFILL_AGENTS.join(", ")}`,
      );
    out.agents = list as BackfillAgent[];
  }
  return out;
}

export interface BackfillDeps {
  /** Null when nobody is signed in. */
  client: ApiClient | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  log: (line: string) => void;
  /** Asks the person; undefined without a terminal. */
  confirm?: (message: string) => Promise<boolean>;
  pid: number;
  alive?: Alive;
  concurrency?: number;
  /** Instruction files to send with each extract, read from the backfilled repo's checkout. */
  readInstructions?: (checkout: string) => string | undefined;
}

/** `impression backfill`. Returns the exit code. */
export async function backfill(
  args: BackfillArgs,
  deps: BackfillDeps,
): Promise<number> {
  const { log, env } = deps;
  if (!deps.client) {
    log(NOT_SIGNED_IN);
    return 1;
  }
  const client = deps.client;
  const repo = findRepo(args.repo ?? deps.cwd);
  if (!repo) {
    log(
      `impression backfill runs in a git repo; ${args.repo ?? deps.cwd} isn't in one.`,
    );
    return 1;
  }

  if (args.undo) return undo(client, repo, args, deps);

  const alive = deps.alive ?? holderAlive;
  if (!args.dryRun && !acquireLock(env, repo.key, deps.pid, alive)) {
    log(
      `A backfill is already running for ${repo.key}. impression status shows its progress.`,
    );
    return 1;
  }
  try {
    const plan = await makePlan(client, repo, args, env, deps.now());
    for (const l of formatPlan(plan)) log(l);
    if (!plan.send.length && !plan.leftOut) {
      log("Nothing new to backfill.");
      return 0;
    }
    if (!plan.send.length) {
      log("Nothing fits in what is left of the backfill budget.");
      return 0;
    }
    if (args.dryRun) {
      log("Dry run: nothing sent.");
      return 0;
    }
    if (!args.yes) {
      if (!deps.confirm) {
        log("Nothing sent. Without a terminal, run it with --yes to send.");
        return 1;
      }
      if (!(await deps.confirm(`Send ${plural(plan.send.length, "piece")}?`))) {
        log("Nothing sent.");
        return 0;
      }
    }
    const startedAt = new Date(deps.now()).toISOString();
    const progress = (t: RunTotals, finishedAt: string | null): Progress => ({
      total: t.total,
      done: t.done,
      saved: t.saved,
      updated: t.updated,
      failed: t.failed,
      notSent: t.notSent,
      costUsd: t.costUsd,
      startedAt,
      finishedAt,
    });
    writeProgress(
      env,
      repo.key,
      progress(
        {
          total: plan.send.length,
          done: 0,
          saved: 0,
          updated: 0,
          failed: 0,
          notSent: 0,
          budgetStopped: false,
          costUsd: 0,
          sessions: 0,
        },
        null,
      ),
    );
    const instructions = deps.readInstructions?.(repo.checkout);
    const totals = await runPlan(client, plan, {
      log,
      ...(deps.concurrency ? { concurrency: deps.concurrency } : {}),
      ...(instructions ? { instructions } : {}),
      onProgress: (t) => writeProgress(env, repo.key, progress(t, null)),
    });
    writeProgress(
      env,
      repo.key,
      progress(totals, new Date(deps.now()).toISOString()),
    );
    for (const l of formatTotals(totals)) log(l);
    return totals.failed ? 1 : 0;
  } finally {
    if (!args.dryRun) releaseLock(env, repo.key, deps.pid);
  }
}

/**
 * `impression backfill --undo`: asks first, as a send does, and holds the
 * repo's lock while it retires. `--dry-run` retires nothing.
 */
async function undo(
  client: ApiClient,
  repo: Repo,
  args: BackfillArgs,
  deps: BackfillDeps,
): Promise<number> {
  const { log, env } = deps;
  if (args.dryRun) {
    log(
      `Dry run: would retire the memories backfills made in ${repo.key}. Nothing retired.`,
    );
    return 0;
  }
  if (!acquireLock(env, repo.key, deps.pid, deps.alive ?? holderAlive)) {
    log(
      `A backfill is already running for ${repo.key}. impression status shows its progress.`,
    );
    return 1;
  }
  try {
    if (!args.yes) {
      if (!deps.confirm) {
        log(
          "Nothing retired. Without a terminal, run it with --yes to retire.",
        );
        return 1;
      }
      if (
        !(await deps.confirm(
          `Retire every memory backfills made in ${repo.key}?`,
        ))
      ) {
        log("Nothing retired.");
        return 0;
      }
    }
    const r = (await client.post(
      `/backfill/undo?project=${encodeURIComponent(repo.key)}`,
      {},
    )) as { retired: number };
    log(
      `Retired ${plural(r.retired, "memory", "memories")} that backfills made in ${repo.key}.`,
    );
    return 0;
  } catch (err) {
    if (apiStatus(err) === 404) {
      log(`Impression has no project ${repo.key} you can reach.`);
      return 1;
    }
    throw err;
  } finally {
    releaseLock(env, repo.key, deps.pid);
  }
}

// ---------------------------------------------------------------- setup's offer

export interface OfferDeps {
  /** Null when setup can't offer: not signed in, or a dry run. The command is printed instead. */
  client: ApiClient | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** False without a terminal: the offer is skipped. */
  interactive: boolean;
  info: (text: string) => void;
  /** Shows the plan and asks whether to start. */
  ask: (plan: string) => Promise<boolean>;
  /** Starts `impression backfill --yes` for the checkout, detached. Rejects when it couldn't. */
  start: (checkout: string) => Promise<void>;
  alive?: Alive;
}

/**
 * The end of `impression setup`: in a git repo with past sessions, shows the
 * backfill plan and, if the person agrees, starts it in the background.
 * Outside a repo, without a terminal, or with no client to plan with, it
 * prints the command instead. Never throws: a failure here prints one line and
 * setup finishes.
 */
export async function offerBackfill(deps: OfferDeps): Promise<void> {
  try {
    const repo = findRepo(deps.cwd);
    if (!repo) {
      deps.info(
        "To learn from a repo's past sessions, run impression backfill in it.",
      );
      return;
    }
    if (!deps.interactive || !deps.client) {
      deps.info(
        "To learn from this repo's past sessions, run: impression backfill",
      );
      return;
    }
    if (lockHolder(deps.env, repo.key, deps.alive) !== undefined) {
      deps.info(
        "A backfill is already running here. impression status shows its progress.",
      );
      return;
    }
    const plan = await makePlan(deps.client, repo, {}, deps.env, deps.now());
    if (!plan.send.length) return;
    const lines = [
      ...formatPlan(plan),
      "",
      "Backfill learns from these past sessions, so your agents know this repo from the start.",
    ];
    if (!(await deps.ask(lines.join("\n")))) {
      deps.info("Skipped. Run impression backfill any time.");
      return;
    }
    try {
      await deps.start(repo.checkout);
    } catch (err) {
      deps.info(
        `Couldn't start the backfill (${err instanceof Error ? err.message : String(err)}). Run it by hand: impression backfill --repo ${repo.checkout}`,
      );
      return;
    }
    deps.info(
      "Backfill started in the background. impression status shows its progress.",
    );
  } catch (err) {
    deps.info(
      `Couldn't plan a backfill (${err instanceof Error ? err.message : String(err)}). Run impression backfill to try again.`,
    );
  }
}
