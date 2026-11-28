import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  chunkTranscript,
  claudeDirName,
  discoverSessions,
  piDirName,
  type Roots,
} from "./transcripts.js";

// `C:\Users\me\code\app` on Windows, as discoverSessions resolves it.
const REPO = resolve("/Users/me/code/app");

const line = (o: unknown) => JSON.stringify(o);
const piMsg = (role: string, text: string) =>
  line({ type: "message", message: { role, content: text } });

function roots(): Roots {
  const base = mkdtempSync(join(tmpdir(), "imp-transcripts-"));
  const r = {
    pi: join(base, "pi"),
    claude: join(base, "claude"),
    codex: join(base, "codex"),
  };
  for (const d of Object.values(r)) mkdirSync(d, { recursive: true });
  return r;
}

function put(path: string, lines: string[]) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n"));
}

const piHeader = (cwd: string, ts: string, id = "pi-id") =>
  line({ type: "session", version: 3, id, timestamp: ts, cwd });

describe("dir names", () => {
  test("match what pi and Claude Code write", () => {
    expect(piDirName("/Users/clearing/silk/silk-remix")).toBe(
      "--Users-clearing-silk-silk-remix--",
    );
    expect(piDirName("/Users/c/.local/x")).toBe("--Users-c-.local-x--");
    expect(
      claudeDirName("/Users/clearing/code/impression/.worktrees/foo"),
    ).toBe("-Users-clearing-code-impression--worktrees-foo");
  });

  test("match what pi and Claude Code write on Windows", () => {
    expect(piDirName("C:\\Users\\tom\\code\\silk-remix")).toBe(
      "--C--Users-tom-code-silk-remix--",
    );
    expect(claudeDirName("C:\\Users\\tom\\silk\\silk-remix")).toBe(
      "C--Users-tom-silk-silk-remix",
    );
  });
});

describe("discoverSessions", () => {
  test("pi: the repo dir and dirs under it, by the file's own cwd", () => {
    const r = roots();
    put(join(r.pi, piDirName(REPO), "a.jsonl"), [
      piHeader(REPO, "2026-10-02T00:00:00Z", "a"),
    ]);
    put(join(r.pi, piDirName(`${REPO}/.worktrees/x`), "b.jsonl"), [
      piHeader(`${REPO}/.worktrees/x`, "2026-10-01T00:00:00Z", "b"),
    ]);
    // A sibling repo whose encoded name shares the prefix.
    put(join(r.pi, piDirName(`${REPO}-old`), "c.jsonl"), [
      piHeader(`${REPO}-old`, "2026-10-01T00:00:00Z"),
    ]);
    put(join(r.pi, piDirName("/elsewhere"), "d.jsonl"), [
      piHeader("/elsewhere", "2026-10-01T00:00:00Z"),
    ]);
    const found = discoverSessions(REPO, { roots: r, agents: ["pi"] });
    expect(found.map((s) => [s.agent, s.sessionKey])).toEqual([
      ["pi", "b"],
      ["pi", "a"],
    ]);
  });

  test("claude: top-level files only, matched by cwd", () => {
    const r = roots();
    const dir = join(r.claude, claudeDirName(REPO));
    put(join(dir, "s1.jsonl"), [
      line({ type: "queue-operation", timestamp: "2026-10-05T00:00:00Z" }),
      line({ type: "user", cwd: REPO, sessionId: "s1", message: {} }),
    ]);
    put(join(dir, "s1", "subagents", "agent-1.jsonl"), [
      line({ type: "user", cwd: REPO, timestamp: "2026-10-05T00:00:00Z" }),
    ]);
    put(join(r.claude, claudeDirName(`${REPO}/.worktrees/w`), "s2.jsonl"), [
      line({
        type: "user",
        cwd: `${REPO}/.worktrees/w`,
        timestamp: "2026-10-04T00:00:00Z",
      }),
    ]);
    // `app-web` encodes like `app/web`; its cwd says it's a different repo.
    put(join(r.claude, claudeDirName(`${REPO}-web`), "s3.jsonl"), [
      line({ type: "user", cwd: `${REPO}-web`, timestamp: "2026-10-04Z" }),
    ]);
    const found = discoverSessions(REPO, { roots: r, agents: ["claude"] });
    expect(found.map((s) => s.sessionKey)).toEqual(["s2", "s1"]);
  });

  test("codex: rollouts whose session_meta cwd is the repo or under it", () => {
    const r = roots();
    const meta = (cwd: string, id: string, ts: string) =>
      line({ timestamp: ts, type: "session_meta", payload: { id, cwd } });
    put(join(r.codex, "2026", "10", "01", "rollout-a.jsonl"), [
      meta(`${REPO}/packages/x`, "a", "2026-10-01T00:00:00Z"),
    ]);
    put(join(r.codex, "2026", "10", "02", "rollout-b.jsonl"), [
      meta("/other", "b", "2026-10-02T00:00:00Z"),
    ]);
    put(join(r.codex, "2026", "10", "02", "notes.jsonl"), [
      meta(REPO, "c", "2026-10-02T00:00:00Z"),
    ]);
    const found = discoverSessions(REPO, { roots: r, agents: ["codex"] });
    expect(found.map((s) => [s.agent, s.sessionKey, s.cwd])).toEqual([
      ["codex", "a", `${REPO}/packages/x`],
    ]);
  });

  test("reads every dir it is given, such as a worktree outside the repo, once each", () => {
    const r = roots();
    const tree = resolve("/Users/me/trees/app-fix");
    put(join(r.pi, piDirName(REPO), "a.jsonl"), [
      piHeader(REPO, "2026-10-01T00:00:00Z", "a"),
    ]);
    put(join(r.claude, claudeDirName(tree), "w.jsonl"), [
      line({ type: "user", cwd: tree, timestamp: "2026-10-02T00:00:00Z" }),
    ]);
    put(join(r.codex, "rollout-t.jsonl"), [
      line({
        timestamp: "2026-10-03T00:00:00Z",
        type: "session_meta",
        payload: { id: "t", cwd: `${tree}/src` },
      }),
    ]);
    const found = discoverSessions([REPO, tree, REPO], { roots: r });
    expect(found.map((s) => s.sessionKey)).toEqual(["a", "w", "t"]);
  });

  test("orders all agents oldest first, falling back to mtime, and honours since", () => {
    const r = roots();
    put(join(r.pi, piDirName(REPO), "new.jsonl"), [
      piHeader(REPO, "2026-10-09T00:00:00Z", "new"),
    ]);
    const noTs = join(r.claude, claudeDirName(REPO), "old.jsonl");
    put(noTs, [line({ type: "user", cwd: REPO, sessionId: "old" })]);
    const t = new Date("2026-09-01T00:00:00Z");
    utimesSync(noTs, t, t);
    put(join(r.codex, "rollout-mid.jsonl"), [
      line({
        timestamp: "2026-10-05T00:00:00Z",
        type: "session_meta",
        payload: { id: "mid", cwd: REPO },
      }),
    ]);
    expect(
      discoverSessions(REPO, { roots: r }).map((s) => s.sessionKey),
    ).toEqual(["old", "mid", "new"]);
    expect(
      discoverSessions(REPO, {
        roots: r,
        since: Date.parse("2026-10-01"),
      }).map((s) => s.sessionKey),
    ).toEqual(["mid", "new"]);
  });
});

describe("chunkTranscript", () => {
  test("splits on whole lines, keeping each piece's text under the cap", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      piMsg(i % 2 ? "assistant" : "user", `${i}`.repeat(990)),
    );
    const chunks = chunkTranscript(lines.join("\n"), 3000, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.chars).toBeLessThanOrEqual(3000);
    expect(chunks.flatMap((c) => c.raw.split("\n"))).toEqual(lines);
  });

  test("a line over the cap is its own piece; tiny pieces are dropped", () => {
    const big = piMsg("user", "x".repeat(5000));
    const tiny = piMsg("assistant", "ok");
    const chunks = chunkTranscript([tiny, big, tiny].join("\n"), 3000, 500);
    expect(chunks.map((c) => c.raw)).toEqual([big]);
    expect(chunkTranscript([tiny, tiny].join("\n"), 3000, 500)).toEqual([]);
  });

  test("tool noise rides along without counting", () => {
    const noise = line({ type: "toolResult", content: "z".repeat(100_000) });
    const chunks = chunkTranscript(
      [piMsg("user", "a".repeat(600)), noise].join("\n"),
      3000,
      500,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.raw).toContain("toolResult");
  });
});
