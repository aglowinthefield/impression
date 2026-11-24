// pi extension: injects saved memories at session start and for each prompt, and sends the
// transcript to Impression when it ends. Shells out to the `impression` CLI, so it
// shares config (`impression login`) and fail-quietly behaviour with the Claude Code hooks.
//
// Also registers the Impression MCP server, so pi gets the search and add tools.
//
// Install: `pi install npm:@aglowinthefield/impression`, or add this file's path to
// "extensions" in ~/.pi/agent/settings.json. Works from the npm package
// (`pi/impression.ts` beside `dist/`) and from a checkout (`packages/pi` beside
// `packages/cli/dist`). Falls back to `impression` on PATH. Override the CLI location
// with IMPRESSION_CLI.
//
// Also runs in oh-my-pi (omp), which loads pi packages but runs extensions in Bun and
// differs in a few events; the comments below say where.
import { execFile, spawn } from "node:child_process";
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

/** The CLI library, loaded into this process. Null if it can't be found. */
async function loadCli() {
  try {
    const path = local("../dist/lib.js", "../cli/dist/lib.js");
    return path ? await import(pathToFileURL(path).href) : null;
  } catch {
    return null;
  }
}

/**
 * A client for the per-prompt search, which then skips a node start-up and reuses one
 * HTTP connection. Null if the library isn't loaded or isn't signed in.
 */
// biome-ignore lint/suspicious/noExplicitAny: the library is loaded at runtime
function connect(cli: any) {
  try {
    if (!cli) return null;
    const { url, token } = cli.loadConfig();
    if (!token) return null;
    // The saved client picks up a re-login without a restart; older libraries lack it.
    const client = cli.createSavedClient
      ? cli.createSavedClient("pi", fetch)
      : cli.createClient(url, token, fetch, "pi");
    return { cli, client };
  } catch {
    return null;
  }
}

const SCRIPT =
  process.env.IMPRESSION_CLI ??
  local("../dist/impression.js", "../cli/dist/bin.js");

/** pi runs on node, so its own binary runs the CLI. omp runs on Bun, or as a compiled binary, so it uses node from PATH. */
const NODE = process.versions.bun ? "node" : process.execPath;

/**
 * Runs the CLI in a detached node process that outlives this one, then deletes `dir`.
 * For the last chunk at shutdown: omp gives shutdown handlers 2 seconds, and
 * extraction takes longer.
 */
const HAND_OFF = `const [cli, dir, input, ...args] = process.argv.slice(1);
const { execFileSync } = require("node:child_process");
try {
  execFileSync(cli ? process.execPath : "impression", cli ? [cli, ...args] : args,
    { input, stdio: ["pipe", "ignore", "ignore"], timeout: 35000 });
} catch {}
require("node:fs").rmSync(dir, { recursive: true, force: true });`;

function handOff(args: string[], cwd: string, input: string, dir: string) {
  try {
    const child = spawn(
      NODE,
      ["-e", HAND_OFF, SCRIPT ?? "", dir, input, ...args],
      { cwd, detached: true, stdio: "ignore" },
    );
    child.on("error", () => rmSync(dir, { recursive: true, force: true }));
    child.unref();
  } catch {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(
  args: string[],
  cwd: string,
  opts: { input?: string; timeout: number },
): Promise<string> {
  return new Promise((resolve) => {
    const [cmd, argv] = SCRIPT
      ? [NODE, [SCRIPT, ...args]]
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

const MCP_SCRIPT = local("../dist/impression-mcp.js", "../mcp/dist/bin.js");

export default function (pi: ExtensionAPI) {
  // Runs the bundled server with this node, so it doesn't depend on what's on PATH.
  // An "impression" entry in mcp.json takes precedence over this one.
  if (MCP_SCRIPT && typeof pi.registerMcpServer === "function")
    pi.registerMcpServer("impression", {
      command: NODE,
      args: [MCP_SCRIPT],
    });

  let context = "";
  /** Memories given to the agent this session, shown in the footer so the person sees Impression at work. */
  let given = 0;
  const showGiven = (ctx: {
    hasUI: boolean;
    ui: { setStatus?(key: string, text: string | undefined): void };
  }) => {
    if (ctx.hasUI && given > 0)
      ctx.ui.setStatus?.(
        "impression",
        `Impression: ${given} ${given === 1 ? "memory" : "memories"} in this session`,
      );
  };
  let injected = false;
  const seen = new Set<string>();
  let lib: ReturnType<typeof connect> = null;
  let sent = 0; // entries of the session file already sent
  let sending: Promise<void> = Promise.resolve();

  /** pi's id for the session, logged with the memories it is served. */
  const sessionId = (ctx: {
    sessionManager: { getSessionId?(): string | undefined };
  }): string | undefined => ctx.sessionManager.getSessionId?.() || undefined;

  /**
   * Sends session entries not sent yet as their own session, and queues extraction.
   * At shutdown the send is handed to a detached process, so exiting doesn't cut it off.
   */
  const flush = (
    ctx: {
      cwd: string;
      sessionManager: {
        getEntries(): unknown[];
        getSessionId?(): string | undefined;
      };
    },
    minChars: number,
    detach = false,
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
    const args = ["hook", "session-end", "--extract", "--agent", "pi"];
    const write = () => {
      const dir = mkdtempSync(join(tmpdir(), "impression-"));
      const file = join(dir, "chunk.jsonl");
      writeFileSync(file, text);
      const input = JSON.stringify({
        transcript_path: file,
        cwd: ctx.cwd,
        session_id: sessionId(ctx),
      });
      return { dir, input };
    };
    if (detach) {
      try {
        const { dir, input } = write();
        handOff(args, ctx.cwd, input, dir);
      } catch {}
      return;
    }
    sending = sending.then(async () => {
      let dir: string | undefined;
      try {
        const w = write();
        dir = w.dir;
        await run(args, ctx.cwd, { input: w.input, timeout: 35_000 });
      } catch {
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    injected = false;
    seen.clear();
    given = 0;
    if (ctx.hasUI) ctx.ui.setStatus?.("impression", undefined);
    sent = ctx.sessionManager.getEntries().length;
    const cli = await loadCli();
    // After an update, show what changed, once. Checked only with a UI, so a print-mode
    // run doesn't use up the notice. pi (1.5+) already shows the package's CHANGELOG.md
    // under "Extension Updates", so only omp (on Bun) needs this one.
    if (ctx.hasUI && process.versions.bun) {
      const note = cli?.upgradeNotice?.(cli.VERSION);
      if (note) ctx.ui.notify(note, "info");
    }
    lib = connect(cli);
    // The staleness check runs in a detached CLI process, at most once an hour per project.
    if (lib && SCRIPT)
      try {
        lib.cli.startRecheck?.(ctx.cwd, "pi", { script: SCRIPT, node: NODE });
      } catch {}
    const opts = { session: sessionId(ctx), agent: "pi" };
    if (!lib) {
      context = "";
      // Installed but nobody signed in: say so, or it looks like it works.
      if (ctx.hasUI && cli?.NOT_SIGNED_IN)
        ctx.ui.notify(cli.NOT_SIGNED_IN, "warning");
      return;
    }
    // Older bundles have only sessionStartContext.
    if (!lib.cli.sessionStart) {
      context =
        (await lib.cli.sessionStartContext(lib.client, ctx.cwd, opts)) ?? "";
      return;
    }
    const start = await lib.cli.sessionStart(lib.client, ctx.cwd, opts);
    context = start?.context ?? "";
    given = start?.count ?? 0;
    if (given > 0) {
      // Memories went in: a footer count, updated as prompts find more.
      showGiven(ctx);
      return;
    }
    // Nothing yet: one line saying this repo can't be saved, or memories are on their way.
    const notice = ctx.hasUI
      ? lib.cli.sessionStartNotice(start, lib.cli.loadConfig().url)
      : null;
    if (notice)
      ctx.ui.notify(notice, start?.reachable === false ? "warning" : "info");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // pi marks the kind of message; omp has no `messageType`, and its only
    // non-prompt start is a revived subagent.
    const e = event as { messageType?: string; reason?: string };
    if (e.messageType !== undefined && e.messageType !== "user") return;
    if (e.reason === "revive") return;
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
            lib.cli.promptContext(lib.client, ctx.cwd, prompt, {
              session: sessionId(ctx),
              agent: "pi",
            }),
            new Promise<null>((r) => setTimeout(r, 2_000, null).unref()),
          ])
        : null;
    const found = (result ?? "")
      .split("\n")
      .filter((l: string) => l.startsWith("- ") && !seen.has(l));
    for (const l of found) seen.add(l);
    given += found.length;
    if (found.length) showGiven(ctx);
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
  // omp has no `agent_settled`, so `agent_end` covers it there. In pi both fire, and
  // the second finds nothing new to send.
  pi.on("agent_settled", async (_event, ctx) => flush(ctx, CHUNK_CHARS));
  pi.on("agent_end", async (_event, ctx) => flush(ctx, CHUNK_CHARS));

  pi.on("session_shutdown", async (event, ctx) => {
    if ((event as { reason?: string }).reason === "reload") return;
    flush(ctx, 1, true);
  });
}
