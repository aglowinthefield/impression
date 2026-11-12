import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  readInstructions,
  sendSession,
  transcriptText,
} from "./session-end.js";

const jsonl = [
  { type: "permission-mode" },
  { type: "user", message: { content: "fix the build" } },
  {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Done, it was the tsconfig." },
        { type: "tool_use", name: "Bash" },
      ],
    },
  },
  {
    type: "user",
    message: { content: [{ type: "tool_result", content: "x" }] },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "imp-end-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/ex.git"],
    { cwd: dir },
  );
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    ],
    { cwd: dir },
  );
  const file = join(dir, "t.jsonl");
  writeFileSync(file, jsonl);
  return { dir, file };
}

describe("transcriptText", () => {
  test("keeps user and assistant text only", () => {
    expect(transcriptText(jsonl)).toBe(
      "user: fix the build\n\nassistant: Done, it was the tsconfig.",
    );
  });
  test("bad lines are skipped", () => {
    expect(transcriptText("{nope\n")).toBe("");
  });
});

const lines = (...es: unknown[]) => es.map((e) => JSON.stringify(e)).join("\n");

describe("transcriptText, other agents", () => {
  test("Codex rollout: drops developer messages and injected instructions", () => {
    const msg = (role: string, ...text: string[]) => ({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: text.map((t) => ({
          type: role === "assistant" ? "output_text" : "input_text",
          text: t,
        })),
      },
    });
    const raw = lines(
      { type: "session_meta", payload: {} },
      msg("developer", "You are Codex"),
      msg(
        "user",
        "# AGENTS.md instructions for /x",
        "<environment_context>\n</environment_context>",
      ),
      msg("user", "fix the build"),
      { type: "response_item", payload: { type: "reasoning" } },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell" },
      },
      msg("assistant", "Done."),
      { type: "event_msg", payload: { type: "token_count" } },
    );
    expect(transcriptText(raw)).toBe("user: fix the build\n\nassistant: Done.");
  });

  test("Cursor: role at the top level", () => {
    const raw = lines(
      { role: "user", message: { content: [{ type: "text", text: "hi" }] } },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
    );
    expect(transcriptText(raw)).toBe("user: hi\n\nassistant: hello");
  });

  test("Gemini JSONL: patches, rewinds and string or part content", () => {
    const raw = lines(
      { sessionId: "s", projectHash: "p", startTime: "t" },
      { id: "1", type: "user", content: [{ text: "first try" }] },
      { id: "2", type: "gemini", content: "draft" },
      { $rewindTo: "1" },
      { id: "3", type: "user", content: [{ text: "fix the build" }] },
      { id: "4", type: "gemini", content: "work" },
      { $patch: { id: "4", content: "Done." } },
      { id: "5", type: "info", content: "noise" },
    );
    expect(transcriptText(raw)).toBe("user: fix the build\n\nassistant: Done.");
  });

  test("Gemini legacy single JSON file", () => {
    const raw = JSON.stringify(
      {
        sessionId: "s",
        messages: [
          { id: "1", type: "user", content: "hi" },
          { id: "2", type: "gemini", content: "hello" },
        ],
      },
      null,
      2,
    );
    expect(transcriptText(raw)).toBe("user: hi\n\nassistant: hello");
  });

  test("Copilot CLI events", () => {
    const raw = lines(
      { type: "session.start", data: {} },
      { type: "user.message", data: { content: "hi" } },
      { type: "tool.execution_start", data: {} },
      { type: "assistant.message", data: { content: "hello" } },
    );
    expect(transcriptText(raw)).toBe("user: hi\n\nassistant: hello");
  });
});

describe("sendSession", () => {
  test("posts the transcript with project and HEAD, then extracts", async () => {
    const { dir, file } = setup();
    const calls: [string, unknown][] = [];
    const id = await sendSession(
      {
        get: async () => null,
        post: async (p, b) => {
          calls.push([p, b]);
          return { id: "s1" };
        },
      },
      { transcript_path: file, cwd: dir },
      { extract: true },
    );
    expect(id).toBe("s1");
    expect(calls[0]?.[0]).toBe("/sessions");
    expect(calls[0]?.[1]).toMatchObject({
      project: { key: "github.com/acme/ex" },
      transcript: expect.stringContaining("fix the build"),
      commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      agent: "claude-code",
    });
    expect(calls[1]?.[0]).toBe("/sessions/s1/extract");
  });
  test("a chunk the server already has is not extracted again", async () => {
    const { dir, file } = setup();
    const paths: string[] = [];
    await sendSession(
      {
        get: async () => null,
        post: async (p) => {
          paths.push(p);
          return { id: "s1", duplicate: true };
        },
      },
      { transcript_path: file, cwd: dir },
      { extract: true },
    );
    expect(paths).toEqual(["/sessions"]);
  });
  test("API failure or missing file gives null", async () => {
    const { dir, file } = setup();
    const bad = {
      get: async () => null,
      post: async () => {
        throw new Error("down");
      },
    };
    expect(
      await sendSession(bad, { transcript_path: file, cwd: dir }),
    ).toBeNull();
    expect(
      await sendSession(bad, { transcript_path: "/nope", cwd: dir }),
    ).toBeNull();
    expect(await sendSession(bad, {})).toBeNull();
  });
});

test("transcriptText reads pi session files", () => {
  const jsonl = [
    '{"type":"session","id":"s"}',
    '{"type":"message","message":{"role":"system","content":"prompt"}}',
    '{"type":"message","message":{"role":"user","content":"use pnpm"}}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"toolCall","name":"bash"}]}}',
    '{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"noise"}]}}',
  ].join("\n");
  expect(transcriptText(jsonl)).toBe("user: use pnpm\n\nassistant: ok");
});

describe("instructions", () => {
  const home = mkdtempSync(join(tmpdir(), "imp-home-"));
  test("readInstructions reads project and global files, skipping missing", () => {
    const { dir } = setup();
    writeFileSync(join(dir, "AGENTS.md"), "never push\n");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "use pnpm");
    const text = readInstructions(dir, home) ?? "";
    expect(text).toContain("never push");
    expect(text).toContain("use pnpm");
    expect(text).not.toContain("CLAUDE.md");
    expect(
      readInstructions(mkdtempSync(join(tmpdir(), "e-")), "/nope"),
    ).toBeUndefined();
  });
  test("sent to extract only when sendInstructions is on", async () => {
    const { dir, file } = setup();
    writeFileSync(join(dir, "AGENTS.md"), "never push");
    const run = async (sendInstructions: boolean) => {
      const calls: [string, unknown][] = [];
      await sendSession(
        {
          get: async () => null,
          post: async (p, b) => {
            calls.push([p, b]);
            return { id: "s1" };
          },
        },
        { transcript_path: file, cwd: dir },
        { extract: true, sendInstructions },
      );
      return calls[1]?.[1];
    };
    expect(await run(false)).toEqual({});
    expect(await run(true)).toMatchObject({
      instructions: expect.stringContaining("never push"),
    });
  });
});
