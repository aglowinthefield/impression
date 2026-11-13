import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AnchorRef {
  path: string;
  symbol?: string | null;
  commitSha: string;
}

export type AnchorState = "ok" | "stale" | "unknown";

export interface AnchorCheck {
  state: AnchorState;
  /** Human-readable reason when not ok. */
  reason?: string;
}

const MAX_SYMBOL_FILE_BYTES = 1_000_000;

/** Files changed between `sha` and the working tree, or null if git can't tell (unknown commit, no repo). */
function changedSince(repo: string, sha: string): Set<string> | null {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", sha, "--"],
      {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasSymbol(file: string, symbol: string): boolean | null {
  try {
    if (statSync(file).size > MAX_SYMBOL_FILE_BYTES) return null;
    const re = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
    return re.test(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Checks anchors against a checkout, returning one result per input, in order.
 *
 * Stale means: the path is gone, the symbol is no longer in the file, or the
 * file changed since the recorded commit and the anchor has no symbol to
 * confirm it is still valid. A changed file whose symbol is still present is
 * ok: the symbol is the stronger signal. If the recorded commit is unknown to
 * this checkout the result is "unknown", never stale.
 *
 * Cost is one `git diff` per distinct commit plus a file read per symbol anchor
 * on a changed file, so it stays cheap enough to run on every search. Pass the
 * same `changed` map to calls on the same checkout to diff each commit once.
 */
export function verifyAnchors(
  repo: string,
  anchors: AnchorRef[],
  changed = new Map<string, Set<string> | null>(),
): AnchorCheck[] {
  for (const a of anchors) {
    if (!changed.has(a.commitSha))
      changed.set(a.commitSha, changedSince(repo, a.commitSha));
  }

  return anchors.map((a): AnchorCheck => {
    const file = join(repo, a.path);
    if (!existsSync(file))
      return { state: "stale", reason: `${a.path} no longer exists` };

    const diff = changed.get(a.commitSha);
    if (diff === null || diff === undefined) {
      return {
        state: "unknown",
        reason: `commit ${a.commitSha.slice(0, 7)} not found in this checkout`,
      };
    }
    if (!diff.has(a.path)) return { state: "ok" };

    if (a.symbol) {
      const found = hasSymbol(file, a.symbol);
      if (found === null)
        return { state: "unknown", reason: `couldn't read ${a.path}` };
      return found
        ? { state: "ok" }
        : { state: "stale", reason: `${a.symbol} is no longer in ${a.path}` };
    }
    return {
      state: "stale",
      reason: `${a.path} changed since ${a.commitSha.slice(0, 7)}`,
    };
  });
}

/** Folds anchor checks into one verdict for the memory: stale if any anchor is, with the reasons joined. */
export function summarizeChecks(checks: AnchorCheck[]): AnchorCheck {
  const stale = checks.filter((c) => c.state === "stale");
  if (stale.length > 0)
    return { state: "stale", reason: stale.map((c) => c.reason).join("; ") };
  if (checks.length > 0 && checks.every((c) => c.state === "unknown")) {
    return { state: "unknown", reason: checks[0]?.reason };
  }
  return { state: "ok" };
}
