import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeOutput, sessionStartContext } from "./hook.js";

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "imp-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/ex.git"],
    { cwd: dir },
  );
  return dir;
};

describe("sessionStartContext", () => {
  test("lists memories under a header and asks for the project", async () => {
    let path = "";
    const text = await sessionStartContext(
      {
        get: async (p) => {
          path = p;
          return { items: [{ content: "Use pnpm" }, { content: "No ORMs" }] };
        },
        post: async () => null,
      },
      repo(),
    );
    expect(path).toBe("/core?project=github.com%2Facme%2Fex&budget=800");
    expect(text).toBe(
      "Saved memories for ex (from Impression; use the impression search tool for more):\n- Use pnpm\n- No ORMs",
    );
  });
  test("nothing to show gives null", async () => {
    const c = { get: async () => ({ items: [] }), post: async () => null };
    expect(await sessionStartContext(c, repo())).toBeNull();
  });
  test("API failure gives null, not a throw", async () => {
    const c = {
      get: async () => {
        throw new Error("down");
      },
      post: async () => null,
    };
    expect(await sessionStartContext(c, repo())).toBeNull();
  });
  test("Claude Code output shape", () => {
    expect(JSON.parse(claudeCodeOutput("hi"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "hi",
      },
    });
  });
});

test("promptContext lists matching memories and is null on failure", async () => {
  const { promptContext } = await import("./hook.js");
  const ok = {
    post: async () => ({ results: [{ content: "use pnpm" }] }),
  } as never;
  expect(await promptContext(ok, "/tmp", "how do I install")).toBe(
    "Memories from Impression that match this prompt:\n- use pnpm",
  );
  const none = { post: async () => ({ results: [] }) } as never;
  expect(await promptContext(none, "/tmp", "x")).toBeNull();
  const down = {
    post: async () => {
      throw new Error("down");
    },
  } as never;
  expect(await promptContext(down, "/tmp", "x")).toBeNull();
  expect(await promptContext(ok, "/tmp", "  ")).toBeNull();
});
