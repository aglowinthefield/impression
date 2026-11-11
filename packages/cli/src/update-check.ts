import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "@impression/shared";

export const PACKAGE = "@aglowinthefield/impression";
const DAY = 24 * 60 * 60 * 1000;

declare const __IMPRESSION_VERSION__: string | undefined;
/** Set by the bundler. Undefined when run from a plain tsc build. */
export const VERSION: string | undefined =
  typeof __IMPRESSION_VERSION__ === "string"
    ? __IMPRESSION_VERSION__
    : undefined;

interface Cache {
  checkedAt: number;
  latest?: string;
}

const cachePath = (env: NodeJS.ProcessEnv) =>
  join(dirname(configPath(env)), "update-check.json");

const parse = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];

/** True when `latest` is a higher x.y.z than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

export function updateNotice(latest: string, current: string): string {
  return `impression ${latest} is available (you have ${current}). Run: impression update`;
}

/**
 * Once a day, asks the npm registry for the latest version. Returns a notice if it is newer
 * than `current`, else undefined. Never throws and gives up after `timeoutMs`; the attempt is
 * recorded first, so an offline machine isn't retried until tomorrow. Not for hooks.
 */
export async function checkForUpdate(
  current: string | undefined,
  opts: {
    env?: NodeJS.ProcessEnv;
    now?: number;
    timeoutMs?: number;
    fetchLatest?: (signal: AbortSignal) => Promise<string | undefined>;
  } = {},
): Promise<string | undefined> {
  if (!current) return undefined;
  const env = opts.env ?? process.env;
  if (env.IMPRESSION_NO_UPDATE_CHECK) return undefined;
  try {
    const path = cachePath(env);
    const now = opts.now ?? Date.now();
    let cache: Cache = { checkedAt: 0 };
    try {
      cache = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    if (now - cache.checkedAt >= DAY) {
      const attempt: Cache = { checkedAt: now, latest: cache.latest };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(attempt));
      const fetchLatest =
        opts.fetchLatest ??
        (async (signal) => {
          const res = await fetch(
            `https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/latest`,
            { signal },
          );
          return res.ok
            ? ((await res.json()) as { version?: string }).version
            : undefined;
        });
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 1000);
      try {
        const latest = await fetchLatest(ctl.signal);
        if (latest) {
          cache = { checkedAt: now, latest };
          writeFileSync(path, JSON.stringify(cache));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return cache.latest && isNewer(cache.latest, current)
      ? updateNotice(cache.latest, current)
      : undefined;
  } catch {
    return undefined;
  }
}
