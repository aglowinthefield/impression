import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type AnchorRef,
  type ApiClient,
  configPath,
  resolveProject,
  summarizeChecks,
  verifyAnchors,
} from "@impression/shared";

const HOUR = 60 * 60 * 1000;
/** Memories sent to the model per run, so one big refactor can't run up a bill. */
export const MAX_RECHECKS = 20;
/** The server shows the model at most this much file text in total, so no file needs more. */
const MAX_FILE_CHARS = 40_000;
/** Files per recheck and length of the reason, as the server accepts them. */
const MAX_FILES = 20;
const MAX_REASON = 1000;
/** Bigger files are generated or binary, not something a memory describes. */
const MAX_READ_BYTES = 5_000_000;
/** Matches the server's page size for `/memories/anchored`. */
const PAGE = 500;
const MAX_PAGES = 20;
/** A lock older than this was left by a process that died holding it. */
const STALE_LOCK_MS = 60_000;

const throttleDir = (env: NodeJS.ProcessEnv) =>
  join(dirname(configPath(env)), "recheck");

/**
 * True at most once an hour per project, recording the run as it answers, so
 * sessions opened together don't all start a check. Each project has its own
 * timestamp file, written under a lock and replaced by rename, so concurrent
 * sessions can't both claim or lose another project's time. Any error means false.
 */
export function claimRecheck(
  projectKey: string,
  opts: { env?: NodeJS.ProcessEnv; now?: number; everyMs?: number } = {},
): boolean {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  try {
    const dir = throttleDir(env);
    mkdirSync(dir, { recursive: true });
    const file = join(
      dir,
      createHash("sha256").update(projectKey).digest("hex").slice(0, 32),
    );
    const lock = `${file}.lock`;
    let fd: number;
    try {
      fd = openSync(lock, "wx");
    } catch {
      // Another session is claiming right now. A lock left by a crash is cleared for the next one.
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS)
          rmSync(lock, { force: true });
      } catch {}
      return false;
    }
    try {
      let prev = Number.NaN;
      try {
        prev = Number(readFileSync(file, "utf8"));
      } catch {}
      if (Number.isFinite(prev) && now - prev < (opts.everyMs ?? HOUR))
        return false;
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, String(now));
      renameSync(tmp, file);
      return true;
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
    }
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", ["--literal-pathspecs", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * A file as committed at HEAD: null if HEAD doesn't have it, undefined if it
 * can't be sent (too big, a symlink, a submodule or a directory). The working
 * tree is never read, so the check judges what anchors move to.
 */
function headFile(root: string, path: string): string | null | undefined {
  if (git(root, "cat-file", "-e", `HEAD:${path}`) === null) return null;
  const entry = git(root, "ls-tree", "-l", "HEAD", "--", path) ?? "";
  const m = /^(\d+) (\w+) \S+ +(\d+|-)\t/.exec(entry);
  if (!m || m[1] === "120000" || m[2] !== "blob") return undefined;
  if (Number(m[3]) > MAX_READ_BYTES) return undefined;
  return git(root, "show", `HEAD:${path}`) ?? undefined;
}

/** Paths with uncommitted changes, untracked files included. Null if git can't tell. */
function dirtyPaths(root: string): Set<string> | null {
  const out = git(
    root,
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  );
  if (out === null) return null;
  return new Set(
    out
      .split("\0")
      .filter((e) => e.length > 3)
      .map((e) => e.slice(3)),
  );
}

interface Anchored {
  id: string;
  anchors: (AnchorRef & { id: string })[];
}

async function listAnchored(
  client: ApiClient,
  project: string,
): Promise<Anchored[]> {
  const all: Anchored[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items } = (await client.get(
      `/memories/anchored?${new URLSearchParams({ project, offset: String(page * PAGE) })}`,
    )) as { items: Anchored[] };
    all.push(...(items ?? []));
    if ((items?.length ?? 0) < PAGE) break;
  }
  return all;
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 3)}...` : s;

/**
 * Checks the project's anchored memories against HEAD of this checkout and sends
 * each stale one, with its changed files as committed, to the server to keep,
 * rewrite or retire. Memories with an anchored path that has uncommitted changes
 * wait until it is committed. Only the anchors checked here are reported as
 * checked, so the server leaves the rest alone. Returns how many were sent.
 * Never throws.
 */
export async function recheckProject(
  client: ApiClient,
  cwd: string,
  limit = MAX_RECHECKS,
): Promise<number> {
  try {
    const root = git(cwd, "rev-parse", "--show-toplevel")?.trim();
    const head = root && git(root, "rev-parse", "HEAD")?.trim();
    if (!root || !head) return 0;
    const dirty = dirtyPaths(root);
    if (!dirty) return 0;
    const p = resolveProject(cwd);
    const items = await listAnchored(client, p.key);
    const changed = new Map<string, Set<string> | null>();
    let sent = 0;
    for (const m of items) {
      if (sent >= limit) break;
      if (m.anchors.some((a) => dirty.has(a.path))) continue;
      const checks = verifyAnchors(root, m.anchors, changed);
      const summary = summarizeChecks(checks);
      if (summary.state !== "stale") continue;
      const paths = [
        ...new Set(
          m.anchors
            .filter((_, i) => checks[i]?.state === "stale")
            .map((a) => a.path),
        ),
      ].slice(0, MAX_FILES);
      const files = paths.map((path) => {
        const content = headFile(root, path);
        if (typeof content !== "string") return { path, content };
        return content.length > MAX_FILE_CHARS
          ? {
              path,
              content: content.slice(0, MAX_FILE_CHARS),
              size: content.length,
            }
          : { path, content };
      });
      // An unreadable file would look deleted to the server, which drops its anchor.
      if (files.some((f) => f.content === undefined)) continue;
      const sentPaths = new Map(files.map((f) => [f.path, f.content]));
      const checked = m.anchors.flatMap((a, i) => {
        const state = checks[i]?.state;
        if (state === "ok") return [{ id: a.id }];
        if (state !== "stale" || !sentPaths.has(a.path)) return [];
        // Stale with its file still there and a symbol: the symbol is what went.
        return a.symbol && sentPaths.get(a.path) !== null
          ? [{ id: a.id, symbolGone: true }]
          : [{ id: a.id }];
      });
      sent++;
      try {
        await client.post(`/memories/${m.id}/recheck`, {
          reason: clip(summary.reason ?? "anchored files changed", MAX_REASON),
          commitSha: head,
          files,
          checked,
        });
      } catch {}
    }
    return sent;
  } catch {
    return 0;
  }
}
