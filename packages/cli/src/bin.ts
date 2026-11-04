#!/usr/bin/env node
import { createClient } from "@impression/shared";
import { claudeCodeOutput, sessionStartContext } from "./hook.js";

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
} else {
  console.error("usage: impression hook session-start [--plain]");
  process.exit(2);
}
