import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "@impression/shared";
import { isNewer } from "./update-check.js";

const CHANGELOG_URL =
  "https://github.com/aglowinthefield/impression/blob/main/CHANGELOG.md";
const MAX_LINES = 8;

/** The bullets of every `## x.y.z` section newer than `previous`, up to `current`. */
export function changesSince(
  changelog: string,
  previous: string,
  current: string,
): string[] {
  return changelog.split(/^## /m).flatMap((section) => {
    const version = /^\[?(\d+\.\d+\.\d+)/.exec(section)?.[1];
    if (!version || !isNewer(version, previous) || isNewer(version, current))
      return [];
    return (section.match(/^- .*/gm) ?? []).map((line) =>
      line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim(),
    );
  });
}

/**
 * The first time it runs after an upgrade, returns what changed since the last version
 * seen on this machine. Records `current` as seen, so each upgrade shows once. Returns
 * undefined on a fresh install, a downgrade, or when the seen version can't be saved
 * (which would repeat the notice every session). Never throws.
 */
export function upgradeNotice(
  current: string | undefined,
  opts: { env?: NodeJS.ProcessEnv; changelog?: string } = {},
): string | undefined {
  if (!current) return undefined;
  try {
    const path = join(
      dirname(configPath(opts.env ?? process.env)),
      "last-seen-version.json",
    );
    let previous: string | undefined;
    try {
      previous = JSON.parse(readFileSync(path, "utf8")).version;
    } catch {}
    if (previous === current) return undefined;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: current }));
    if (!previous || !isNewer(current, previous)) return undefined;
    const text =
      opts.changelog ??
      readFileSync(
        fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)),
        "utf8",
      );
    const lines = changesSince(text, previous, current);
    return [
      `Impression updated from ${previous} to ${current}`,
      ...lines.slice(0, MAX_LINES),
      ...(lines.length > MAX_LINES
        ? [`...and ${lines.length - MAX_LINES} more`]
        : []),
      `Changelog: ${CHANGELOG_URL}`,
    ].join("\n");
  } catch {
    return undefined;
  }
}
