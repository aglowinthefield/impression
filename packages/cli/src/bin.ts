#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createClient } from "@impression/shared";
import {
  accept,
  add,
  edit,
  keep,
  list,
  proposals,
  reject,
  retire,
  search,
  status,
} from "./commands.js";
import { loadConfig, saveConfig } from "./config.js";
import { pushEvalTurns } from "./eval-push.js";
import { githubDeviceLogin } from "./github-login.js";
import { runHook } from "./hook-run.js";
import {
  formatSetup,
  HARNESSES,
  type Harness,
  oldHookFiles,
  setup,
} from "./setup.js";
import { checkForUpdate, PACKAGE, VERSION } from "./update-check.js";

const [cmd, sub] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-v" || cmd === "version") {
  console.log(VERSION ?? "dev");
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
  try {
    execFileSync("npm", ["i", "-g", `${PACKAGE}@latest`], { stdio: "inherit" });
  } catch {
    process.exit(1);
  }
} else if (cmd === "setup") {
  const rest = process.argv.slice(3);
  const i = rest.indexOf("--only");
  const only = i >= 0 ? rest[i + 1] : undefined;
  if (i >= 0 && !HARNESSES.includes(only as Harness)) {
    console.error(
      `usage: impression setup [--dry-run] [--only ${HARNESSES.join("|")}]`,
    );
    process.exit(2);
  }
  const dryRun = rest.includes("--dry-run");
  try {
    const result = setup({
      home: homedir(),
      only: only as Harness | undefined,
      dryRun,
    });
    console.log(formatSetup(result, dryRun));
    if (!token)
      console.log("Not signed in yet. Run: impression login --github");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else if (cmd === "login") {
  const rest = process.argv.slice(3);
  const flag = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const newUrl = flag("--url") ?? url;
  let newToken = flag("--token");
  if (rest.includes("--github")) {
    try {
      newToken = (await githubDeviceLogin(newUrl)).token;
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }
  newToken ??= token;
  if (!newToken) {
    console.error(
      "usage: impression login --github | --token imp_... [--url https://impression.quest]",
    );
    process.exit(2);
  }
  try {
    const who = (await createClient(newUrl, newToken).get("/whoami")) as {
      name: string;
    };
    saveConfig({ url: newUrl, token: newToken });
    console.log(`Signed in to ${newUrl} as ${who.name}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
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
  [
    "search",
    "add",
    "list",
    "status",
    "proposals",
    "accept",
    "reject",
    "retire",
    "edit",
    "keep",
  ].includes(cmd)
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
      throw new Error(`usage: impression ${cmd} <text>`);
    if (["accept", "reject", "retire", "edit", "keep"].includes(cmd) && !id)
      throw new Error(
        `usage: impression ${cmd} <id>${cmd === "edit" ? " <text>" : ""}`,
      );
    if (cmd === "edit" && !text)
      throw new Error("usage: impression edit <id> <text>");
    const run = {
      search: () => search(client, cwd, words),
      add: () =>
        add(client, cwd, words, {
          user: args.includes("--user"),
          pin: args.includes("--pin"),
        }),
      list: () => list(client, cwd),
      status: async () => {
        const old = oldHookFiles();
        const s = await status(client, cwd, url);
        return old.length
          ? `${s}\nOld hooks: ${old.join(", ")} (they do nothing now; run impression setup)`
          : s;
      },
      proposals: () => proposals(client, cwd),
      accept: () => accept(client, cwd, id ?? "", text || undefined),
      reject: () => reject(client, cwd, id ?? ""),
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
  console.error(
    "usage: impression --version | setup [--dry-run] [--only claude|pi|codex] | update\n       impression login [--github] | search <q> | add <text> [--user] [--pin] | list | status\n       impression proposals | accept <id> [edited text] | reject <id> | retire <id> | edit <id> <text> | keep <id>\n       impression hook session-start | prompt | session-end [--extract] --agent claude|codex|gemini|cursor|copilot|pi\n       impression eval push [path-substring]",
  );
  process.exit(2);
}
