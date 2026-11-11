// pi extension: injects saved memories at session start and for each prompt, and sends the
// transcript to Impression when it ends. Shells out to the `impression` CLI, so it
// shares config (`impression login`) and fail-quietly behaviour with the Claude Code hooks.
//
// Install: `impression setup`, or add this file's path to "extensions" in
// ~/.pi/agent/settings.json. Works from the npm package (`pi/impression.ts` beside
// `dist/`) and from a checkout (`packages/pi` beside `packages/cli/dist`). Falls back to
// `impression` on PATH. Override the CLI location with IMPRESSION_CLI.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** First of these paths (relative to this file) that exists, or undefined. */
function local(...paths: string[]) {
  return paths
    .map((p) => fileURLToPath(new URL(p, import.meta.url)))
    .find((p) => existsSync(p));
}

/**
 * Loads the CLI library into this process, so the per-prompt search skips a node
 * start-up and reuses one HTTP connection. Null if it can't be found or isn't signed in.
 */
async function loadLib() {
  try {
    const path = local("../dist/lib.js", "../cli/dist/lib.js");
    if (!path) return null;
    const cli = await import(pathToFileURL(path).href);
    const { url, token } = cli.loadConfig();
    if (!token) return null;
    return { cli, client: cli.createClient(url, token) };
  } catch {
    return null;
  }
}

const SCRIPT =
  process.env.IMPRESSION_CLI ??
  local("../dist/impression.js", "../cli/dist/bin.js");

function run(
  args: string[],
  cwd: string,
  opts: { input?: string; timeout: number },
): Promise<string> {
  return new Promise((resolve) => {
    const [cmd, argv] = SCRIPT
      ? [process.execPath, [SCRIPT, ...args]]
      : ["impression", args];
    const child = execFile(
      cmd,
      argv,
      { cwd, timeout: opts.timeout, encoding: "utf8" },
      (_err, stdout) => resolve(stdout ?? ""),
    );
    child.on("error", () => resolve(""));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
}

/** Send a chunk once this much new text has built up. Each send costs one extraction call. */
const CHUNK_CHARS = 3000;

/** Prompts shorter than this ("yes", "continue") carry nothing to search on. */
const MIN_PROMPT_CHARS = 15;

export default function (pi: ExtensionAPI) {
  let context = "";
  let injected = false;
  const seen = new Set<string>();
  let lib: Awaited<ReturnType<typeof loadLib>> = null;
  let sent = 0; // entries of the session file already sent
  let sending: Promise<void> = Promise.resolve();

  /** Sends session entries not sent yet as their own session, and queues extraction. */
  const flush = (
    ctx: {
      cwd: string;
      sessionManager: { getEntries(): unknown[] };
    },
    minChars: number,
  ) => {
    const entries = ctx.sessionManager.getEntries();
    const fresh = entries.slice(sent);
    const text = fresh.map((e) => JSON.stringify(e)).join("\n");
    // Count only conversation text, not the system prompt or tool output.
    const talk = fresh.reduce((n: number, e) => {
      const m = (e as { type?: string; message?: { role?: string } }).message;
      const ok = m?.role === "user" || m?.role === "assistant";
      return ok ? n + JSON.stringify(m).length : n;
    }, 0);
    if (!fresh.length || talk < minChars) return;
    sent = entries.length;
    sending = sending.then(async () => {
      const dir = mkdtempSync(join(tmpdir(), "impression-"));
      try {
        const file = join(dir, "chunk.jsonl");
        writeFileSync(file, text);
        await run(["hook", "session-end", "--extract"], ctx.cwd, {
          input: JSON.stringify({ transcript_path: file, cwd: ctx.cwd }),
          timeout: 35_000,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    injected = false;
    seen.clear();
    sent = ctx.sessionManager.getEntries().length;
    lib = await loadLib();
    context = lib
      ? ((await lib.cli.sessionStartContext(lib.client, ctx.cwd)) ?? "")
      : "";
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    const parts: string[] = [];
    if (!injected && context) {
      injected = true;
      parts.push(context);
    }
    // Search on each substantial prompt, skipping memories already shown this session.
    const prompt = event.prompt?.trim() ?? "";
    const result =
      lib && prompt.length >= MIN_PROMPT_CHARS
        ? await Promise.race([
            lib.cli.promptContext(lib.client, ctx.cwd, prompt),
            new Promise<null>((r) => setTimeout(r, 2_000, null).unref()),
          ])
        : null;
    const found = (result ?? "")
      .split("\n")
      .filter((l: string) => l.startsWith("- ") && !seen.has(l));
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

  // Mid-conversation: after each settled run, send what's new once enough has built up.
  pi.on("agent_settled", async (_event, ctx) => flush(ctx, CHUNK_CHARS));

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    flush(ctx, 1);
    await sending;
  });
}
