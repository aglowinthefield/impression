#!/usr/bin/env node
import { createClient, resolveProject } from "@impression/shared";
import { dashboardUrl, openUrl } from "./browser.js";
import {
  commandHelp,
  overview,
  unknownCommand,
  usageLine,
} from "./cli-help.js";
import { add, edit, keep, list, retire, search, status } from "./commands.js";
import { loadConfig, saveConfig } from "./config.js";
import { pushEvalTurns } from "./eval-push.js";
import { runCommand } from "./global-cli.js";
import { HIDDEN, help } from "./help.js";
import { runHook } from "./hook-run.js";
import { login } from "./login.js";
import { oldHookFiles } from "./setup.js";
import { runSetup } from "./setup-cli.js";
import { checkForUpdate, PACKAGE, VERSION } from "./update-check.js";

const [cmd, sub] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(VERSION ?? "dev");
  process.exit(0);
}
const cli = help(VERSION);
const wantsHelp = process.argv
  .slice(3)
  .some((a) => a === "--help" || a === "-h");
if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  const page = cmd === "help" && sub ? commandHelp(cli, sub) : overview(cli);
  if (!page) {
    console.error(unknownCommand(cli, sub ?? ""));
    process.exit(2);
  }
  console.log(page);
  process.exit(0);
}
if (!HIDDEN.includes(cmd) && !cli.commands.some((c) => c.name === cmd)) {
  console.error(unknownCommand(cli, cmd));
  process.exit(2);
}
if (wantsHelp && !HIDDEN.includes(cmd)) {
  console.log(commandHelp(cli, cmd));
  process.exit(0);
}
const config = loadConfig();
const token = config.token;
const url = config.url;

// A newer-version notice on stderr, at most one registry lookup a day. Never in hooks,
// whose output goes to the agent and which must stay fast.
if (cmd !== "hook" && cmd !== "update" && process.stderr.isTTY) {
  const notice = await checkForUpdate(VERSION);
  if (notice) console.error(notice);
}

if (cmd === "hook") {
  // Hooks always exit 0 and stay quiet on failure: a hook must not break the session.
  await runHook(sub, process.argv.slice(4));
  process.exit(0);
} else if (cmd === "update") {
  const r = runCommand("npm", ["i", "-g", `${PACKAGE}@latest`], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(1);
} else if (cmd === "setup") {
  await runSetup(process.argv.slice(3), { token, url });
} else if (cmd === "login") {
  const rest = process.argv.slice(3);
  const flag = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const newUrl = flag("--url") ?? url;
  try {
    const who = await login(
      {
        url: newUrl,
        token: flag("--token"),
        github: rest.includes("--github"),
        // A saved token belongs to the saved server.
        saved: newUrl === url ? token : undefined,
      },
      { open: openUrl },
    );
    saveConfig({ url: newUrl, token: who.token });
    console.log(`Signed in to ${newUrl} as ${who.name}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (cmd === "dashboard") {
  const target = dashboardUrl(url, resolveProject(process.cwd()).key);
  console.log(target);
  openUrl(target);
} else if (cmd === "eval" && sub === "push") {
  if (!token) {
    console.error("Not signed in. Run: impression login --github");
    process.exit(1);
  }
  const match =
    process.argv[4] && !process.argv[4].startsWith("--")
      ? process.argv[4]
      : undefined;
  try {
    console.log(await pushEvalTurns(createClient(url, token), { match }));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (
  cmd &&
  ["search", "add", "list", "status", "retire", "edit", "keep"].includes(cmd)
) {
  if (!token) {
    console.error("Not signed in. Run: impression login --github");
    process.exit(1);
  }
  const client = createClient(url, token);
  const args = process.argv.slice(3);
  const words = args.filter((a) => !a.startsWith("--")).join(" ");
  try {
    const [id, ...restWords] = args.filter((a) => !a.startsWith("--"));
    const text = restWords.join(" ");
    const cwd = process.cwd();
    if ((cmd === "search" || cmd === "add") && !words)
      throw new Error(usageLine(cli, cmd));
    if (["retire", "edit", "keep"].includes(cmd) && !id)
      throw new Error(usageLine(cli, cmd));
    if (cmd === "edit" && !text) throw new Error(usageLine(cli, cmd));
    const run = {
      search: () => search(client, cwd, words),
      add: () =>
        add(client, cwd, words, {
          user: args.includes("--user"),
        }),
      list: () => list(client, cwd),
      status: async () => {
        const old = oldHookFiles();
        const s = await status(client, cwd, url);
        return old.length
          ? `${s}\nOld hooks: ${old.join(", ")} (the plugin replaces them; run impression setup to remove them)`
          : s;
      },
      retire: () => retire(client, cwd, id ?? ""),
      edit: () => edit(client, cwd, id ?? "", text),
      keep: () => keep(client, cwd, id ?? ""),
    }[cmd as "search"];
    console.log(await run());
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.error("Usage: impression eval push [PATH_SUBSTRING]");
  process.exit(2);
}
