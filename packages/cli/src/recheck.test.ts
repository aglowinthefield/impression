import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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

  test("a corrupt timestamp file doesn't block the check", () => {
    const e = env();
    mkdirSync(join(e.XDG_CONFIG_HOME, "impression"), { recursive: true });
    writeFileSync(join(e.XDG_CONFIG_HOME, "impression", "recheck.json"), "{");
    expect(claimRecheck("k", { env: e })).toBe(true);
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

describe("recheckProject", () => {
  test("sends stale memories with their changed files and skips the rest", async () => {
    const { dir, sha } = repo();
    writeFileSync(join(dir, "src/a.ts"), "export const bar = 2\n");
    writeFileSync(join(dir, "src/b.ts"), "export const keep = 2\n");
    rmSync(join(dir, "src/c.ts"));
    git(dir, "commit", "-qam", "two");
    const head = git(dir, "rev-parse", "HEAD");
    const client = fakeClient([
      // Symbol gone, and a file deleted: stale.
      {
        id: "m1",
        anchors: [
          { path: "src/a.ts", symbol: "foo", commitSha: sha },
          { path: "src/c.ts", commitSha: sha },
        ],
      },
      // File changed but the symbol is still there: ok.
      {
        id: "m2",
        anchors: [{ path: "src/b.ts", symbol: "keep", commitSha: sha }],
      },
      // Commit this checkout has never seen: unknown, so skipped.
      {
        id: "m3",
        anchors: [{ path: "src/a.ts", commitSha: "f".repeat(40) }],
      },
    ]);

    expect(await recheckProject(client, join(dir, "src"))).toBe(1);
    expect(client.gets).toEqual([
      "/memories/anchored?project=github.com%2Facme%2Frc",
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
        },
      },
    ]);
  });

  test("stops at the cap and keeps going past a failed recheck", async () => {
    const { dir, sha } = repo();
    writeFileSync(join(dir, "src/a.ts"), "export const bar = 2\n");
    const items = ["m1", "m2", "m3"].map((id) => ({
      id,
      anchors: [{ path: "src/a.ts", symbol: "foo", commitSha: sha }],
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
