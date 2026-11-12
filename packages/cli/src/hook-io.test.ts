import { describe, expect, test } from "vitest";
import {
  agentArg,
  foreignHost,
  formatContext,
  hookCwd,
  hookTranscript,
  parseHookInput,
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
});
