/**
 * What differs between agents' hooks: how a hook learns its directory and prompt,
 * how it hands context back, and whether it is running in the agent it was written for.
 */

export const AGENTS = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "copilot",
  "pi",
] as const;
export type Agent = (typeof AGENTS)[number];

export function isAgent(v: unknown): v is Agent {
  return AGENTS.includes(v as Agent);
}

/** The value of `--agent`, or undefined when it is missing or unknown. */
export function agentArg(argv: string[]): Agent | undefined {
  const i = argv.indexOf("--agent");
  const v = i >= 0 ? argv[i + 1] : undefined;
  return isAgent(v) ? v : undefined;
}

/**
 * Cursor and Copilot also run Claude Code's plugins and hooks. A hook written for one
 * agent that finds itself in another stays silent, so each agent's own plugin is the
 * only one that acts. Returns the agent the environment belongs to when it isn't
 * `agent`, else undefined.
 */
export function foreignHost(
  agent: Agent,
  env: NodeJS.ProcessEnv = process.env,
): Agent | undefined {
  const markers: [Agent, boolean][] = [["cursor", !!env.CURSOR_VERSION]];
  for (const [host, present] of markers)
    if (present && host !== agent) return host;
  return undefined;
}

/** The fields hooks read from their stdin JSON, across agents. */
export interface HookInput {
  cwd?: string;
  prompt?: string;
  transcript_path?: string | null;
  transcriptPath?: string | null;
  workspace_roots?: string[];
  workspacePaths?: string[];
}

export function parseHookInput(text: string): HookInput {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The project directory: the hook's cwd field, else the agent's workspace root, else our cwd. */
export function hookCwd(
  input: HookInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    input.cwd ||
    input.workspace_roots?.[0] ||
    input.workspacePaths?.[0] ||
    env.CURSOR_PROJECT_DIR ||
    env.CLAUDE_PROJECT_DIR ||
    process.cwd()
  );
}

export function hookTranscript(input: HookInput): string | undefined {
  return input.transcript_path || input.transcriptPath || undefined;
}

/**
 * Context for the agent, in the shape its hook reads. pi takes plain text. Claude and
 * Codex take `hookSpecificOutput`; Gemini the same as pure JSON; Cursor and Copilot a
 * top-level field.
 */
export function formatContext(
  agent: Agent,
  event: "SessionStart" | "UserPromptSubmit",
  context: string,
): string {
  switch (agent) {
    case "pi":
      return context;
    case "cursor":
      return JSON.stringify({ additional_context: context });
    case "copilot":
      return JSON.stringify({ additionalContext: context });
    default:
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName:
            agent === "gemini" && event === "UserPromptSubmit"
              ? "BeforeAgent"
              : event,
          additionalContext: context,
        },
      });
  }
}

/** The name sessions are stored under. */
export function sessionAgent(agent: Agent): string {
  return agent === "claude" ? "claude-code" : agent;
}
