import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { pushEvalTurns } from "./eval-push.js";

test("uploads each prompt with its injected memories, keyed by project", async () => {
  const repo = mkdtempSync(join(tmpdir(), "imp-evalrepo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/ex.git"],
    { cwd: repo },
  );
  const dir = mkdtempSync(join(tmpdir(), "imp-sessions-"));
  mkdirSync(join(dir, "proj"));
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    join(dir, "proj", "a.jsonl"),
    [
      line({ type: "session", id: "sess-1", cwd: repo }),
      line({
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "how do I build" },
      }),
      line({
        type: "custom_message",
        customType: "impression",
        content: "Memories:\n- Run pnpm install",
      }),
      line({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "pnpm install first" }],
        },
      }),
    ].join("\n"),
  );
  const sent: { path: string; body: { turns: Record<string, unknown>[] } }[] =
    [];
  const out = await pushEvalTurns(
    {
      post: async (path: string, body: unknown) =>
        sent.push({ path, body: body as never }),
    } as never,
    { dir },
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.path).toBe("/evals/turns");
  expect(sent[0]?.body.turns[0]).toMatchObject({
    project: { key: "github.com/acme/ex" },
    agentSessionId: "sess-1",
    turnIndex: 0,
    prompt: "how do I build",
    injected: ["Run pnpm install"],
    at: "2026-01-01T00:00:00.000Z",
  });
  expect(out).toContain(
    "Pushed 1 prompts from 1 sessions (1 had memories injected)",
  );
  expect(
    await pushEvalTurns({ post: async () => {} } as never, {
      dir,
      match: "nomatch",
    }),
  ).toContain("Pushed 0 prompts");
});
