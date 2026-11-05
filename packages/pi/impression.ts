// pi extension: injects saved memories at the start of a session and sends the
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

  pi.on("session_start", async (_event, ctx) => {
    injected = false;
    context = (
      await run(["hook", "session-start", "--plain"], ctx.cwd, {
        timeout: 10_000,
      })
    ).trim();
  });

  pi.on("before_agent_start", async (event) => {
    if (injected || !context || event.messageType !== "user") return;
    injected = true;
    return {
      message: { customType: "impression", content: context, display: false },
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
