import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { PACKAGE } from "./update-check.js";

/**
 * The `impression` command for the review commands (`status`, `list`, `retire`...).
 * The agent plugins don't need it: they run the CLI bundled in their own package.
 * `npx ... setup` leaves nothing behind, so setup offers the global install.
 */
export const CLI_INSTALL: [string, string[]] = ["npm", ["i", "-g", PACKAGE]];
const CLI_LINE = CLI_INSTALL.flat().join(" ");

/**
 * Whether `impression` is on PATH. Skips npx's temporary bin directories, which
 * hold the command only while `npx @aglowinthefield/impression setup` runs.
 */
export function cliOnPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  windows = process.platform === "win32",
): boolean {
  const names = windows ? ["impression.cmd", "impression.exe"] : ["impression"];
  return (env.PATH ?? env.Path ?? "")
    .split(windows ? ";" : delimiter)
    .filter((dir) => dir && !/[\\/]_npx[\\/]/.test(dir))
    .some((dir) => names.some((n) => exists(join(dir, n))));
}

/**
 * Installs the global CLI unless it's already there. `ask` is the person's answer
 * (absent when setup runs without questions, which means yes). Returns a line for
 * setup's summary, or undefined when there's nothing to say.
 */
export async function offerGlobalCli(opts: {
  onPath: boolean;
  dryRun?: boolean;
  ask?: () => Promise<boolean>;
  install: (command: string, args: string[]) => boolean;
}): Promise<string | undefined> {
  if (opts.onPath) return undefined;
  if (opts.dryRun) return `cli: would run ${CLI_LINE}`;
  if (opts.ask && !(await opts.ask()))
    return `cli: skipped. For impression status, list and update, run: ${CLI_LINE}`;
  return opts.install(...CLI_INSTALL)
    ? "cli: installed the impression command"
    : `cli: install failed. Run it yourself: ${CLI_LINE}`;
}
