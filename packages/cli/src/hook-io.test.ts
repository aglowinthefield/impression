import { describe, expect, test } from "vitest";
import {
  agentArg,
  foreignHost,
  formatContext,
  formatPrompt,
  formatSessionStart,
  hookCwd,
  hookSessionId,
  hookTranscript,
  parseHookInput,
  sessionMode,
} from "./hook-io.js";

describe("hook io", () => {
  test("agentArg takes known agents only", () => {
    expect(agentArg(["--extract", "--agent", "codex"])).toBe("codex");
    expect(agentArg(["--agent", "vim"])).toBeUndefined();
    expect(agentArg(["--extract"])).toBeUndefined();
  });

  test("a Claude hook inside Cursor is foreign; Cursor's own is not", () => {
    const env = { CURSOR_VERSION: "2.1" };
    expect(foreignHost("claude", env)).toBe("cursor");
    expect(foreignHost("cursor", env)).toBeUndefined();
    expect(foreignHost("claude", {})).toBeUndefined();
  });

  test("IMPRESSION_SESSION picks read or off, and anything else is a normal session", () => {
    expect(sessionMode({ IMPRESSION_SESSION: "read" })).toBe("read");
    expect(sessionMode({ IMPRESSION_SESSION: " OFF " })).toBe("off");
    expect(sessionMode({ IMPRESSION_SESSION: "nope" })).toBe("full");
    expect(sessionMode({})).toBe("full");
  });

  test("context shape per agent", () => {
    expect(formatContext("pi", "SessionStart", "hi")).toBe("hi");
    expect(JSON.parse(formatContext("claude", "SessionStart", "hi"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "hi",
      },
    });
    expect(
      JSON.parse(formatContext("gemini", "UserPromptSubmit", "hi"))
        .hookSpecificOutput.hookEventName,
    ).toBe("BeforeAgent");
    expect(JSON.parse(formatContext("cursor", "SessionStart", "hi"))).toEqual({
      additional_context: "hi",
    });
    expect(JSON.parse(formatContext("copilot", "SessionStart", "hi"))).toEqual({
      additionalContext: "hi",
    });
  });

  test("session start adds a notice for the person in Claude Code and Codex only", () => {
    expect(JSON.parse(formatSessionStart("claude", null, "on") ?? "")).toEqual({
      systemMessage: "on",
    });
    expect(JSON.parse(formatSessionStart("codex", "ctx", "on") ?? "")).toEqual({
      systemMessage: "on",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "ctx",
      },
    });
    expect(formatSessionStart("pi", null, "on")).toBeNull();
    expect(formatSessionStart("pi", "ctx", "on")).toBe("ctx");
    expect(formatSessionStart("claude", null, null)).toBeNull();
  });

  test("prompt output tells the person in Claude Code and Codex", () => {
    expect(JSON.parse(formatPrompt("claude", "- a", "found 1"))).toEqual({
      systemMessage: "found 1",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "- a",
      },
    });
    expect(formatPrompt("pi", "- a", "found 1")).toBe("- a");
  });

  test("cwd and transcript from each agent's input", () => {
    expect(hookCwd({ cwd: "/a", workspace_roots: ["/b"] }, {})).toBe("/a");
    expect(hookCwd({ workspace_roots: ["/b"] }, {})).toBe("/b");
    expect(hookCwd({ workspacePaths: ["/c"] }, {})).toBe("/c");
    expect(hookCwd({}, { CURSOR_PROJECT_DIR: "/d" })).toBe("/d");
    expect(hookTranscript({ transcriptPath: "/t" })).toBe("/t");
    expect(hookTranscript({ transcript_path: null })).toBeUndefined();
    expect(parseHookInput("not json")).toEqual({});
    expect(parseHookInput("[1]")).toEqual({});
  });

  test("session id from each agent's input", () => {
    expect(hookSessionId({ session_id: "claude-1" })).toBe("claude-1");
    expect(hookSessionId({ sessionId: "copilot-1" })).toBe("copilot-1");
    expect(
      hookSessionId({ conversation_id: "cursor-1", session_id: "other" }),
    ).toBe("cursor-1");
    expect(hookSessionId({ session_id: "  " })).toBeUndefined();
    expect(hookSessionId({ session_id: 7 } as never)).toBeUndefined();
    expect(hookSessionId({})).toBeUndefined();
    expect(hookSessionId({ session_id: "x".repeat(300) })).toHaveLength(200);
  });
});
