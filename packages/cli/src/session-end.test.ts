import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sendSession, transcriptText } from "./session-end.js";

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
