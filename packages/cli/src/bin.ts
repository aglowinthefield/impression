#!/usr/bin/env node
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
import { claudeCodeOutput, sessionStartContext } from "./hook.js";
import { sendSession } from "./session-end.js";

const [cmd, sub] = process.argv.slice(2);
const config = loadConfig();
const token = config.token;
const url = config.url;

if (cmd === "hook" && sub === "session-start") {
  // Always exit 0 and stay quiet on failure: a hook must not break the session.
  if (token) {
    const ctx = await sessionStartContext(
      createClient(url, token),
      process.cwd(),
    );
    if (ctx) {
      const plain = process.argv.includes("--plain");
      process.stdout.write(`${plain ? ctx : claudeCodeOutput(ctx)}\n`);
    }
  }
} else if (cmd === "hook" && sub === "session-end") {
  // Fail quietly, and give up after a few seconds so exit is never held up.
  if (token) {
    const stdin = await new Promise<string>((resolve) => {
      let data = "";
      process.stdin.on("data", (d) => {
        data += d;
      });
      process.stdin.on("end", () => resolve(data));
      setTimeout(() => resolve(data), 2000).unref();
    });
    let input = {};
    try {
      input = JSON.parse(stdin);
    } catch {}
    const client = createClient(url, token);
    await Promise.race([
      sendSession(client, input, {
        extract: process.argv.includes("--extract"),
      }),
      new Promise((r) => setTimeout(r, 30_000).unref()),
    ]);
  }
  process.exit(0);
} else if (cmd === "login") {
  const rest = process.argv.slice(3);
  const flag = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const newToken = flag("--token") ?? token;
  if (!newToken) {
    console.error(
      "usage: impression login --token imp_... [--url http://host:3000]",
    );
    process.exit(2);
  }
  const newUrl = flag("--url") ?? url;
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
    console.error("Not signed in. Run: impression login --token imp_...");
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
      status: () => status(client, cwd, url),
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
    "usage: impression login | search <q> | add <text> [--user] [--pin] | list | status\n       impression proposals | accept <id> [edited text] | reject <id> | retire <id> | edit <id> <text> | keep <id>\n       impression hook session-start [--plain] | session-end [--extract]",
  );
  process.exit(2);
}
