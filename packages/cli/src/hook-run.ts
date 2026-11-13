import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, resolveProject } from "@impression/shared";
import { loadConfig } from "./config.js";
import { promptContext, sessionStartContext } from "./hook.js";
import {
  type Agent,
  agentArg,
  foreignHost,
  formatContext,
  hookCwd,
  hookTranscript,
  parseHookInput,
  sessionAgent,
} from "./hook-io.js";
import { claimRecheck, recheckProject } from "./recheck.js";
import { sendSession } from "./session-end.js";

/** Stdin as text. Gives up after `ms`, and reads nothing from a terminal. */
function readStdin(ms: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (d) => {
      data += d;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), ms).unref();
  });
}

/**
 * `impression hook <sub> --agent <agent>`. A hook without `--agent` was written by an
 * older setup; it does nothing, so it can't run alongside a plugin's hook. Neither does
 * a hook running inside an agent it wasn't written for.
 */
export async function runHook(
  sub: string | undefined,
  args: string[],
): Promise<void> {
  const agent = agentArg(args);
  if (!agent || foreignHost(agent)) return;
  const config = loadConfig();
  if (!config.token) return;
  const client = () => createClient(config.url, config.token as string);

  if (sub === "session-start") {
    const input = parseHookInput(await readStdin(1000));
    const cwd = hookCwd(input);
    const ctx = await sessionStartContext(client(), cwd);
    if (ctx)
      process.stdout.write(`${formatContext(agent, "SessionStart", ctx)}\n`);
    startRecheck(cwd, agent);
    return;
  }

  if (sub === "recheck") {
    const cwd = cwdArg(args);
    if (!cwd) return;
    await Promise.race([
      recheckProject(client(), cwd),
      new Promise((r) => setTimeout(r, 120_000).unref()),
    ]);
    return;
  }

  if (sub === "prompt") {
    // pi pipes the prompt text itself; the other agents send their hook JSON.
    const stdin = await readStdin(2000);
    const input = agent === "pi" ? {} : parseHookInput(stdin);
    const prompt = agent === "pi" ? stdin : (input.prompt ?? "");
    const ctx = await promptContext(client(), hookCwd(input), prompt);
    if (ctx)
      process.stdout.write(
        `${formatContext(agent, "UserPromptSubmit", ctx)}\n`,
      );
    return;
  }

  if (sub === "session-end") {
    const extract = args.includes("--extract");
    const upload = args.indexOf("--upload");
    if (upload >= 0) {
      await uploadCopy(args[upload + 1], agent, extract, client());
      return;
    }
    const input = parseHookInput(await readStdin(2000));
    const transcript = hookTranscript(input);
    if (!transcript) return;
    handOff(transcript, hookCwd(input), agent, extract);
  }
}

/**
 * Agents give a session-end hook a second or two before cancelling it, so the upload
 * runs in a detached child. The transcript is copied first: the agent may delete it
 * (pi does) or keep appending to it once the hook returns.
 */
function handOff(
  transcript: string,
  cwd: string,
  agent: Agent,
  extract: boolean,
): void {
  try {
    const dir = mkdtempSync(join(tmpdir(), "impression-end-"));
    copyFileSync(transcript, join(dir, "transcript"));
    writeFileSync(join(dir, "input.json"), JSON.stringify({ cwd }));
    const child = spawn(
      process.execPath,
      [
        process.argv[1] as string,
        "hook",
        "session-end",
        "--agent",
        agent,
        "--upload",
        dir,
        ...(extract ? ["--extract"] : []),
      ],
      { detached: true, stdio: "ignore", cwd },
    );
    child.on("error", () => rmSync(dir, { recursive: true, force: true }));
    child.unref();
  } catch {}
}

/** The checkout `hook recheck` works on, from `--cwd <dir>`. */
export function cwdArg(args: string[]): string | undefined {
  const i = args.indexOf("--cwd");
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

/**
 * The staleness check reads files and waits on the model, too slow for session
 * start, so it runs in a detached child, at most once an hour per project.
 */
function startRecheck(cwd: string, agent: Agent): void {
  try {
    if (!claimRecheck(resolveProject(cwd).key)) return;
    const child = spawn(
      process.execPath,
      [
        process.argv[1] as string,
        "hook",
        "recheck",
        "--agent",
        agent,
        "--cwd",
        cwd,
      ],
      { detached: true, stdio: "ignore", cwd },
    );
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** The detached half: sends the copied transcript, then removes the copy. */
async function uploadCopy(
  dir: string | undefined,
  agent: Agent,
  extract: boolean,
  client: ReturnType<typeof createClient>,
): Promise<void> {
  if (!dir || dirname(dir) !== tmpdir().replace(/\/$/, "")) return;
  try {
    const { cwd } = JSON.parse(readFileSync(join(dir, "input.json"), "utf8"));
    await Promise.race([
      sendSession(
        client,
        { transcript_path: join(dir, "transcript"), cwd },
        {
          extract,
          agent: sessionAgent(agent),
          sendInstructions: loadConfig().sendInstructions,
        },
      ),
      new Promise((r) => setTimeout(r, 120_000).unref()),
    ]);
  } catch {
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
