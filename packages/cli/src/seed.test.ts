import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@impression/shared";
import { describe, expect, test } from "vitest";
import {
  assertLocal,
  chunkTranscript,
  claudeDirName,
  discoverSessions,
  main,
  piDirName,
  type Roots,
  retryable,
  type SeedItem,
  seed,
} from "./seed.js";

const REPO = "/Users/me/code/app";

const line = (o: unknown) => JSON.stringify(o);
const piMsg = (role: string, text: string) =>
  line({ type: "message", message: { role, content: text } });

function roots(): Roots {
  const base = mkdtempSync(join(tmpdir(), "imp-seed-"));
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

describe("assertLocal", () => {
  test("allows this machine, refuses others unless allowed", () => {
    expect(() => assertLocal("http://localhost:3000")).not.toThrow();
    expect(() => assertLocal("http://127.0.0.1:3000")).not.toThrow();
    expect(() => assertLocal("https://impression.quest")).toThrow(
      /--allow-remote/,
    );
    expect(() => assertLocal("https://impression.quest", true)).not.toThrow();
  });

  test("main refuses a remote server from env before sending anything", async () => {
    const repo = gitRepo();
    await expect(
      main(["--repo", repo], {
        IMPRESSION_URL: "https://impression.quest",
        IMPRESSION_TOKEN: "imp_x",
        XDG_CONFIG_HOME: repo,
      }),
    ).rejects.toThrow(/not localhost/);
  });
});

test("retryable: network and 5xx yes, 4xx no", () => {
  expect(retryable(new Error("fetch failed"))).toBe(true);
  expect(retryable(new Error("Impression API 502: extraction failed"))).toBe(
    true,
  );
  expect(retryable(new Error("Impression API 400: bad request"))).toBe(false);
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "imp-seed-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
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
  return dir;
}

describe("seed", () => {
  const item = (n: number): SeedItem => ({
    session: { agent: "pi", path: `/x/s${n}.jsonl`, start: 0, sessionKey: "k" },
    part: 1,
    chunk: { raw: piMsg("user", `chunk ${n} `.repeat(80)), chars: 0 },
  });

  test("counts failures instead of throwing, and retries 5xx", async () => {
    const repo = gitRepo();
    const calls: string[] = [];
    let extracts = 0;
    const seen = new Set<string>();
    const client: ApiClient = {
      get: async () => ({}),
      post: async (path, body) => {
        calls.push(path);
        const t = (body as { transcript?: string }).transcript ?? "";
        if (path === "/sessions") {
          if (t.includes("chunk 1 ")) throw new Error("Impression API 400: no");
          if (t.includes("chunk 2 "))
            return {
              id: "00000000-0000-0000-0000-000000000002",
              duplicate: true,
            };
          const duplicate = seen.has(t);
          seen.add(t);
          return { id: "00000000-0000-0000-0000-000000000003", duplicate };
        }
        // First extract fails with a 502, the retry works.
        if (extracts++ === 0) throw new Error("Impression API 502: try again");
        return { accepted: 2, skippedDuplicates: 1 };
      },
    };
    const lines: string[] = [];
    const totals = await seed(client, [item(1), item(2), item(3)], {
      repo,
      concurrency: 1,
      log: (l) => lines.push(l),
    });
    expect(totals).toEqual({
      chunks: 3,
      uploaded: 0,
      duplicates: 2,
      failed: 1,
      memories: 2,
    });
    expect(lines[0]).toMatch(/^\[1\/3\] pi 1970-01-01 s1\.jsonl#1 failed /);
    expect(lines[1]).toBe("[2/3] pi 1970-01-01 s2.jsonl#1 dup");
    // The retry finds its own chunk stored, and extracts it anyway.
    expect(lines[2]).toBe(
      "[3/3] pi 1970-01-01 s3.jsonl#1 extracted 2 skipped 1 (dup)",
    );
    expect(lines.at(-1)).toBe(
      "done: chunks 3 uploaded 0 duplicates 2 failed 1 memories 2",
    );
    expect(calls.filter((c) => c === "/sessions")).toHaveLength(4);
  });
});
