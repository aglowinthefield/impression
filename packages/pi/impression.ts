// pi extension: injects saved memories at session start and for each prompt, and sends the
// transcript to Impression when it ends. Shells out to the `impression` CLI, so it
// shares config (`impression login`) and fail-quietly behaviour with the Claude Code hooks.
//
// Install: add this file's path to "extensions" in ~/.pi/agent/settings.json.
// Override the CLI location with IMPRESSION_CLI.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLI =
  process.env.IMPRESSION_CLI ??
  fileURLToPath(new URL("../cli/dist/bin.js", import.meta.url));

function run(
  args: string[],
  cwd: string,
  opts: { input?: string; timeout: number },
): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, timeout: opts.timeout, encoding: "utf8" },
      (_err, stdout) => resolve(stdout ?? ""),
    );
    child.stdin?.end(opts.input ?? "");
  });
}

export default function (pi: ExtensionAPI) {
  let context = "";
  let injected = false;
  const seen = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    injected = false;
    seen.clear();
    context = (
      await run(["hook", "session-start", "--plain"], ctx.cwd, {
        timeout: 10_000,
      })
    ).trim();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    const parts: string[] = [];
    if (!injected && context) {
      injected = true;
      parts.push(context);
    }
    // Search on every prompt, skipping memories already shown this session.
    const found = (
      await run(["hook", "prompt"], ctx.cwd, {
        input: event.prompt,
        timeout: 8_000,
      })
    )
      .split("\n")
      .filter((l) => l.startsWith("- ") && !seen.has(l));
    for (const l of found) seen.add(l);
    if (found.length)
      parts.push(
        `Memories from Impression that match this prompt:\n${found.join("\n")}`,
      );
    if (!parts.length) return;
    return {
      message: {
        customType: "impression",
        content: parts.join("\n\n"),
        display: false,
      },
    };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    await run(["hook", "session-end", "--extract"], ctx.cwd, {
      input: JSON.stringify({ transcript_path: file, cwd: ctx.cwd }),
      timeout: 35_000,
    });
  });
}
