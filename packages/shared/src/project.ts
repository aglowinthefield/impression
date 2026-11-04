import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export interface ProjectIdentity {
  /** Stable key: `host/owner/repo` from the git remote, or `path:/abs/root` without one. */
  key: string;
  /** Short display name. */
  name: string;
  /** Working directory relative to the repo root, for narrowing in monorepos. Null at the root. */
  pathPrefix: string | null;
}

/**
 * Normalizes a git remote URL to `host/owner/repo` so ssh, https and scp-style
 * URLs for one repo give the same key. Returns null if the URL isn't recognizable.
 */
export function normalizeRemoteUrl(remote: string): string | null {
  const raw = remote.trim();
  if (!raw) return null;

  let host: string;
  let path: string;

  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp && !raw.includes("://")) {
    host = scp[1] as string;
    path = scp[2] as string;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol === "file:") return null;
    host = url.hostname;
    path = url.pathname;
  }

  path = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!host || !path) return null;
  return `${host.toLowerCase()}/${path}`.replace(/\/{2,}/g, "/");
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

/**
 * Resolves the project a directory belongs to. Clones and worktrees of one
 * repository share a key when the repo has a remote (`origin` first, then the
 * first remote listed). Without a remote, the key falls back to the main
 * checkout's path, which every worktree of that repo shares.
 */
export function resolveProject(cwd: string): ProjectIdentity {
  const start = realpath(resolve(cwd));
  const toplevel = git(start, "rev-parse", "--show-toplevel");
  if (!toplevel) {
    return {
      key: `path:${start}`,
      name: start.split("/").pop() || start,
      pathPrefix: null,
    };
  }

  const rel = relative(toplevel, start);
  const pathPrefix = rel === "" ? null : rel.split("\\").join("/");

  const remotes = (git(start, "remote") ?? "").split("\n").filter(Boolean);
  const remoteName = remotes.includes("origin") ? "origin" : remotes[0];
  const url = remoteName ? git(start, "remote", "get-url", remoteName) : null;
  const normalized = url ? normalizeRemoteUrl(url) : null;
  if (normalized) {
    return {
      key: normalized,
      name: normalized.split("/").pop() as string,
      pathPrefix,
    };
  }

  // The common git dir is shared by all worktrees. Its parent is the main checkout.
  const common = git(
    start,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const root = common ? dirname(common) : toplevel;
  return {
    key: `path:${root}`,
    name: root.split("/").pop() || root,
    pathPrefix,
  };
}

/** Git reports real paths, so a symlinked cwd (macOS /var, /tmp) must be resolved too. */
function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
