#!/usr/bin/env node
import { createClient } from "@impression/shared";
import { add, list, search, status } from "./commands.js";
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
} else if (cmd && ["search", "add", "list", "status"].includes(cmd)) {
  if (!token) {
    console.error("Not signed in. Run: impression login --token imp_...");
    process.exit(1);
  }
  const client = createClient(url, token);
  const args = process.argv.slice(3);
  const words = args.filter((a) => !a.startsWith("--")).join(" ");
  try {
    if (cmd === "search" || cmd === "add") {
      if (!words) throw new Error(`usage: impression ${cmd} <text>`);
    }
    console.log(
      cmd === "search"
        ? await search(client, process.cwd(), words)
        : cmd === "add"
          ? await add(client, process.cwd(), words, {
              user: args.includes("--user"),
              pin: args.includes("--pin"),
            })
          : cmd === "list"
            ? await list(client, process.cwd())
            : await status(client, process.cwd(), url),
    );
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
} else {
  console.error(
    "usage: impression login | search <q> | add <text> [--user] [--pin] | list | status\n       impression hook session-start [--plain] | session-end [--extract]",
  );
  process.exit(2);
}
