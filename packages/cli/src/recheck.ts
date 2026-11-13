import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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
/** Longer files are sent cut short; the server cuts them further anyway. */
const MAX_FILE_CHARS = 200_000;
/** Bigger files are generated or binary, not something a memory describes. */
const MAX_READ_BYTES = 5_000_000;

const throttlePath = (env: NodeJS.ProcessEnv) =>
  join(dirname(configPath(env)), "recheck.json");

/**
 * True at most once an hour per project, recording the run as it answers, so
 * sessions opened together don't all start a check. Any error means false.
 */
export function claimRecheck(
  projectKey: string,
  opts: { env?: NodeJS.ProcessEnv; now?: number; everyMs?: number } = {},
): boolean {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  try {
    const path = throttlePath(env);
    let last: Record<string, number> = {};
    try {
      last = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    const prev = last[projectKey];
    if (typeof prev === "number" && now - prev < (opts.everyMs ?? HOUR))
      return false;
    last[projectKey] = now;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(last));
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** A file as it is now: null if deleted, undefined if it can't be read here. */
function readFile(path: string): string | null | undefined {
  try {
    if (!existsSync(path)) return null;
    if (statSync(path).size > MAX_READ_BYTES) return undefined;
    return readFileSync(path, "utf8").slice(0, MAX_FILE_CHARS);
  } catch {
    return undefined;
  }
}

interface Anchored {
  id: string;
  anchors: AnchorRef[];
}

/**
 * Checks the project's anchored memories against this checkout and sends each
 * stale one, with its changed files as they are now, to the server to keep,
 * rewrite or retire. Anchors that can't be checked here are left alone. Returns
 * how many were sent. Never throws.
 */
export async function recheckProject(
  client: ApiClient,
  cwd: string,
  limit = MAX_RECHECKS,
): Promise<number> {
  try {
    const root = git(cwd, "rev-parse", "--show-toplevel");
    const head = root && git(root, "rev-parse", "HEAD");
    if (!root || !head) return 0;
    const p = resolveProject(cwd);
    const { items } = (await client.get(
      `/memories/anchored?${new URLSearchParams({ project: p.key })}`,
    )) as { items: Anchored[] };
    let sent = 0;
    for (const m of items ?? []) {
      if (sent >= limit) break;
      const checks = verifyAnchors(root, m.anchors);
      const summary = summarizeChecks(checks);
      if (summary.state !== "stale") continue;
      const paths = [
        ...new Set(
          m.anchors
            .filter((_, i) => checks[i]?.state === "stale")
            .map((a) => a.path),
        ),
      ];
      const files = paths.map((path) => ({
        path,
        content: readFile(join(root, path)),
      }));
      // An unreadable file would look deleted to the server, which drops its anchor.
      if (files.some((f) => f.content === undefined)) continue;
      sent++;
      try {
        await client.post(`/memories/${m.id}/recheck`, {
          reason: summary.reason ?? "anchored files changed",
          commitSha: head,
          files,
        });
      } catch {}
    }
    return sent;
  } catch {
    return 0;
  }
}
