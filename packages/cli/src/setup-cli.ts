import { spawn } from "node:child_process";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { createClient } from "@impression/shared";
import { offerBackfill, timedFetch } from "./backfill.js";
import { openUrl } from "./browser.js";
import { loadConfig, saveConfig } from "./config.js";
import { usageLine } from "./cli-help.js";
import { githubDeviceLogin } from "./github-login.js";
import { cliOnPath, offerGlobalCli, runCommand } from "./global-cli.js";
import { help } from "./help.js";
import {
  detect,
  formatSetup,
  HARNESS_NAMES,
  HARNESSES,
  type Harness,
  setup,
} from "./setup.js";

/** Parses `--agent a,b` (or the older `--only a`). Undefined when neither is given. */
export function parseAgents(argv: string[]): Harness[] | undefined | "bad" {
  const i = argv.findIndex((a) => a === "--agent" || a === "--only");
  if (i < 0) return undefined;
  const list = (argv[i + 1] ?? "").split(",").filter(Boolean);
  if (!list.length || list.some((a) => !HARNESSES.includes(a as Harness)))
    return "bad";
  return list as Harness[];
}

/**
 * `impression setup`: signs in if needed, asks which agents to wire up (the ones found
 * are preselected), then installs Impression into each. `--yes`, `--agent` or no
 * terminal skips the question.
 */
export async function runSetup(
  argv: string[],
  config: { token?: string; url: string },
) {
  const picked = parseAgents(argv);
  if (picked === "bad") {
    console.error(
      `impression: --agent takes a comma-separated list of ${HARNESSES.join(", ")}.\n${usageLine(help(), "setup")}`,
    );
    process.exit(2);
  }
  const dryRun = argv.includes("--dry-run");
  const interactive =
    process.stdin.isTTY && !argv.includes("--yes") && !argv.includes("-y");
  const home = homedir();

  p.intro("Impression setup");

  // Sign in first, so a refusal (not on the allowlist, app not installed) comes
  // before anything is installed. Only at a terminal: the device flow needs a person.
  if (!config.token && !dryRun && process.stdin.isTTY) {
    try {
      const { token } = await githubDeviceLogin(config.url, { open: openUrl });
      const who = (await createClient(config.url, token).get("/whoami")) as {
        name: string;
      };
      saveConfig({ url: config.url, token });
      p.log.success(`Signed in to ${config.url} as ${who.name}`);
    } catch (e) {
      p.cancel((e as Error).message);
      process.exit(1);
    }
  }

  const found = detect(home);
  const present = HARNESSES.filter((h) => found[h]);
  let agents = picked;
  if (!agents) {
    if (!present.length) {
      p.outro(
        "No supported agent found. Install Claude Code, Codex, pi or oh-my-pi, then run this again.",
      );
      return;
    }
    if (interactive) {
      const choice = await p.multiselect({
        message: "Which agents should use Impression?",
        options: present.map((h) => ({ value: h, label: HARNESS_NAMES[h] })),
        initialValues: present,
        required: true,
      });
      if (p.isCancel(choice)) {
        p.cancel("Nothing changed.");
        return;
      }
      agents = choice;
    } else agents = present;
  }

  const install = (command: string, args: string[]) => {
    const s = p.spinner();
    const line = [command, ...args].join(" ");
    s.start(line);
    const r = runCommand(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    const ok = r.status === 0;
    if (ok) s.stop(line);
    else s.error(line);
    if (!ok) {
      const why = r.error?.message ?? (r.stderr || r.stdout).trim();
      if (why) p.log.error(why.split("\n").slice(-5).join("\n"));
    }
    return ok;
  };

  try {
    const result = setup({ home, agents, dryRun, install });
    p.log.info(formatSetup(result, dryRun));
    const cli = await offerGlobalCli({
      onPath: cliOnPath(),
      dryRun,
      install,
      ask: interactive
        ? async () => {
            const yes = await p.confirm({
              message:
                "Install the impression command too? It's for impression status, list and update; your agents don't need it.",
            });
            return yes === true;
          }
        : undefined,
    });
    if (cli) p.log.info(cli);
    const saved = loadConfig();
    // Without a sign-in, or in a dry run, this only prints the command.
    await offerBackfill({
      client:
        saved.token && !dryRun
          ? createClient(saved.url, saved.token, timedFetch(30_000))
          : null,
      cwd: process.cwd(),
      env: process.env,
      now: Date.now,
      interactive,
      info: (text) => p.log.info(text),
      ask: async (plan) => {
        p.log.message(plan);
        const yes = await p.confirm({
          message: "Backfill now? It runs in the background.",
        });
        return yes === true;
      },
      start: startBackfill,
    });
    p.outro(
      saved.token
        ? "Done. Start a session in any repo the Impression GitHub app can reach."
        : "Not signed in yet. Run: impression login --github",
    );
  } catch (e) {
    p.cancel((e as Error).message);
    process.exit(1);
  }
}

/**
 * Starts `impression backfill --yes` for a checkout in a detached process that
 * outlives setup, with this CLI's own script and node, as the hooks hand off.
 * Resolves once the process is running; rejects when it couldn't start.
 */
export function startBackfill(
  checkout: string,
  node: string = process.execPath,
  script: string = process.argv[1] as string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      node,
      [script, "backfill", "--yes", "--repo", checkout],
      { detached: true, stdio: "ignore", cwd: checkout, windowsHide: true },
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.on("error", reject);
  });
}
