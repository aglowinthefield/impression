#!/usr/bin/env node
import { createClient } from "@impression/shared";
import { claudeCodeOutput, sessionStartContext } from "./hook.js";
import { sendSession } from "./session-end.js";

const [cmd, sub] = process.argv.slice(2);
const token = process.env.IMPRESSION_TOKEN;

if (cmd === "hook" && sub === "session-start") {
  // Always exit 0 and stay quiet on failure: a hook must not break the session.
  if (token) {
    const ctx = await sessionStartContext(
      createClient(
        process.env.IMPRESSION_URL ?? "http://localhost:3000",
        token,
      ),
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
    const client = createClient(
      process.env.IMPRESSION_URL ?? "http://localhost:3000",
      token,
    );
    await Promise.race([
      sendSession(client, input, {
        extract: process.argv.includes("--extract"),
      }),
      new Promise((r) => setTimeout(r, 30_000).unref()),
    ]);
  }
  process.exit(0);
} else {
  console.error(
    "usage: impression hook session-start [--plain] | session-end [--extract]",
  );
  process.exit(2);
}
