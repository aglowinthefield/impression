import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cwdArg } from "./hook-run.js";
import { claimRecheck, recheckProject } from "./recheck.js";

describe("claimRecheck", () => {
  const env = () => ({
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "imp-recheck-cfg-")),
  });

  test("runs at most once an hour per project", () => {
    const e = env();
    const now = 1_000_000_000;
    expect(claimRecheck("github.com/a/x", { env: e, now })).toBe(true);
    expect(
      claimRecheck("github.com/a/x", { env: e, now: now + 59 * 60_000 }),
    ).toBe(false);
    expect(claimRecheck("github.com/a/y", { env: e, now })).toBe(true);
    expect(
      claimRecheck("github.com/a/x", { env: e, now: now + 61 * 60_000 }),
    ).toBe(true);
  });

  const dir = (e: { XDG_CONFIG_HOME: string }) =>
    join(e.XDG_CONFIG_HOME, "impression", "recheck");

  test("a corrupt or half-written timestamp file doesn't block the check", () => {
    const e = env();
    const now = 1_000_000_000;
    expect(claimRecheck("k", { env: e, now })).toBe(true);
    const [stamp] = readdirSync(dir(e));
    writeFileSync(join(dir(e), stamp as string), "{");
    expect(claimRecheck("k", { env: e, now })).toBe(true);
  });

  test("a session holding the lock wins, and a lock left by a crash is cleared", () => {
    const e = env();
    expect(claimRecheck("k", { env: e, now: 1 })).toBe(true);
    const [stamp] = readdirSync(dir(e));
    const lock = join(dir(e), `${stamp}.lock`);
    const later = 1 + 61 * 60_000;
    // Another session is in the middle of claiming.
    writeFileSync(lock, "");
    expect(claimRecheck("k", { env: e, now: later })).toBe(false);
    expect(existsSync(lock)).toBe(true);
    // That session died holding it.
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    expect(claimRecheck("k", { env: e, now: later })).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(claimRecheck("k", { env: e, now: later })).toBe(true);
  });

  test("claiming one project leaves another's timestamp alone", () => {
    const e = env();
    expect(claimRecheck("x", { env: e, now: 1 })).toBe(true);
    expect(claimRecheck("y", { env: e, now: 2 })).toBe(true);
    expect(claimRecheck("x", { env: e, now: 3 })).toBe(false);
    expect(readdirSync(dir(e))).toHaveLength(2);
  });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "imp-recheck-"));
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "git@github.com:acme/rc.git");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const foo = 1\n");
  writeFileSync(join(dir, "src/b.ts"), "export const keep = 1\n");
  writeFileSync(join(dir, "src/c.ts"), "export const c = 1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

function fakeClient(items: unknown[]) {
  const gets: string[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  return {
    gets,
    posts,
    get: async (p: string) => {
      gets.push(p);
      return { items };
    },
    post: async (path: string, body: unknown) => {
      posts.push({ path, body: body as Record<string, unknown> });
      return {};
    },
  };
}

const A1 = "00000000-0000-4000-8000-000000000001";
const A2 = "00000000-0000-4000-8000-000000000002";
const A3 = "00000000-0000-4000-8000-000000000003";

describe("recheckProject", () => {
  test("sends stale memories with their changed files at HEAD and skips the rest", async () => {
    const { dir, sha } = repo();
    writeFileSync(join(dir, "src/a.ts"), "export const bar = 2\n");
    writeFileSync(join(dir, "src/b.ts"), "export const keep = 2\n");
    rmSync(join(dir, "src/c.ts"));
    git(dir, "commit", "-qam", "two");
    const head = git(dir, "rev-parse", "HEAD");
    const client = fakeClient([
      // Symbol gone, and a file deleted: stale. The unknown commit is left alone.
      {
        id: "m1",
        anchors: [
          { id: A1, path: "src/a.ts", symbol: "foo", commitSha: sha },
          { id: A2, path: "src/c.ts", commitSha: sha },
          { id: A3, path: "src/b.ts", commitSha: "f".repeat(40) },
        ],
      },
      // File changed but the symbol is still there: ok.
      {
        id: "m2",
        anchors: [{ id: A1, path: "src/b.ts", symbol: "keep", commitSha: sha }],
      },
      // Commit this checkout has never seen: unknown, so skipped.
      {
        id: "m3",
        anchors: [{ id: A1, path: "src/a.ts", commitSha: "f".repeat(40) }],
      },
    ]);

    expect(await recheckProject(client, join(dir, "src"))).toBe(1);
    expect(client.gets).toEqual([
      "/memories/anchored?project=github.com%2Facme%2Frc&offset=0",
    ]);
    expect(client.posts).toEqual([
      {
        path: "/memories/m1/recheck",
        body: {
          reason: expect.stringContaining("foo is no longer in src/a.ts"),
          commitSha: head,
          files: [
            { path: "src/a.ts", content: "export const bar = 2\n" },
            { path: "src/c.ts", content: null },
          ],
          checked: [{ id: A1, symbolGone: true }, { id: A2 }],
        },
      },
    ]);
  });

  test("waits on a memory whose anchored file has uncommitted changes", async () => {
    const { dir, sha } = repo();
    writeFileSync(join(dir, "src/a.ts"), "export const bar = 2\n");
    rmSync(join(dir, "src/b.ts"));
    writeFileSync(join(dir, "src/new.ts"), "x\n");
    const client = fakeClient(
      ["src/a.ts", "src/b.ts", "src/new.ts"].map((path, i) => ({
        id: `m${i}`,
        anchors: [{ id: A1, path, commitSha: sha }],
      })),
    );
    expect(await recheckProject(client, dir)).toBe(0);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "two");
    expect(await recheckProject(client, dir)).toBe(3);
    expect(client.posts.map((p) => p.body.files)).toEqual([
      [{ path: "src/a.ts", content: "export const bar = 2\n" }],
      [{ path: "src/b.ts", content: null }],
      [{ path: "src/new.ts", content: "x\n" }],
    ]);
  });

  test("never sends a symlink's target", async () => {
    const { dir, sha } = repo();
    const secret = join(mkdtempSync(join(tmpdir(), "imp-secret-")), "creds");
    writeFileSync(secret, "TOKEN=hunter2\n");
    symlinkSync(secret, join(dir, "src/link"));
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "link");
    rmSync(join(dir, "src/link"));
    symlinkSync(secret, join(dir, "src/link"));
    const client = fakeClient([
      { id: "m1", anchors: [{ id: A1, path: "src/link", commitSha: sha }] },
    ]);
    // Stale (added since `sha`), but a symlink can't be sent.
    expect(await recheckProject(client, dir)).toBe(0);
    expect(JSON.stringify(client.posts)).not.toContain("hunter2");
  });

  test("fits many stale anchors and long files into what the server accepts", async () => {
    const { dir, sha } = repo();
    const anchors = Array.from({ length: 30 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      path: `src/f${i}.ts`,
      symbol: `aVeryLongSymbolNameThatPadsTheReason${i}`,
      commitSha: sha,
    }));
    for (const a of anchors)
      writeFileSync(join(dir, a.path), "x".repeat(50_000));
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "many");
    const client = fakeClient([{ id: "m1", anchors }]);
    expect(await recheckProject(client, dir)).toBe(1);
    const b = client.posts[0]?.body as {
      reason: string;
      files: { content: string; size?: number }[];
      checked: { id: string }[];
    };
    expect(b.reason.length).toBeLessThanOrEqual(1000);
    expect(b.files).toHaveLength(20);
    expect(b.files[0]?.content).toHaveLength(40_000);
    expect(b.files[0]?.size).toBe(50_000);
    // Anchors whose file wasn't sent weren't checked.
    expect(b.checked.map((c) => c.id)).toEqual(
      anchors.slice(0, 20).map((a) => a.id),
    );
  });

  test("reads every page of anchored memories", async () => {
    const { dir, sha } = repo();
    const client = fakeClient([]);
    client.get = async (p: string) => {
      client.gets.push(p);
      const first = p.endsWith("offset=0");
      return {
        items: first
          ? Array.from({ length: 500 }, (_, i) => ({
              id: `ok${i}`,
              anchors: [{ id: A1, path: "src/a.ts", commitSha: sha }],
            }))
          : [],
      };
    };
    expect(await recheckProject(client, dir)).toBe(0);
    expect(client.gets.map((g) => g.split("offset=")[1])).toEqual(["0", "500"]);
  });

  test("stops at the cap and keeps going past a failed recheck", async () => {
    const { dir, sha } = repo();
    writeFileSync(join(dir, "src/a.ts"), "export const bar = 2\n");
    git(dir, "commit", "-qam", "two");
    const items = ["m1", "m2", "m3"].map((id) => ({
      id,
      anchors: [{ id: A1, path: "src/a.ts", symbol: "foo", commitSha: sha }],
    }));
    const client = fakeClient(items);
    let calls = 0;
    client.post = async (path, body) => {
      calls++;
      if (calls === 1) throw new Error("502");
      client.posts.push({ path, body: body as Record<string, unknown> });
      return {};
    };
    expect(await recheckProject(client, dir, 2)).toBe(2);
    expect(client.posts.map((p) => p.path)).toEqual(["/memories/m2/recheck"]);
  });

  test("does nothing outside a git checkout or when the API is down", async () => {
    const plain = mkdtempSync(join(tmpdir(), "imp-recheck-plain-"));
    expect(await recheckProject(fakeClient([]), plain)).toBe(0);
    const { dir } = repo();
    const down = {
      get: async () => {
        throw new Error("down");
      },
      post: async () => null,
    };
    expect(await recheckProject(down, dir)).toBe(0);
  });
});

describe("hook recheck", () => {
  test("takes its checkout from --cwd", () => {
    expect(cwdArg(["--agent", "claude", "--cwd", "/repo"])).toBe("/repo");
    expect(cwdArg(["--agent", "claude"])).toBeUndefined();
    expect(cwdArg(["--cwd"])).toBeUndefined();
    expect(cwdArg(["--cwd", "--agent", "claude"])).toBeUndefined();
  });
});
