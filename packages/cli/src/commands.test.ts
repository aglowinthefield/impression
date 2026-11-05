import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { add, list, search, status } from "./commands.js";
import { configPath, loadConfig, saveConfig } from "./config.js";

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "imp-cli-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/ex.git"],
    { cwd: dir },
  );
  return dir;
};
const fake = (reply: (path: string) => unknown) => {
  const calls: [string, unknown][] = [];
  return {
    calls,
    get: async (p: string) => {
      calls.push([p, undefined]);
      return reply(p);
    },
    post: async (p: string, b: unknown) => {
      calls.push([p, b]);
      return reply(p);
    },
  };
};

describe("commands", () => {
  test("search prints ids, flags and stale warnings", async () => {
    const c = fake(() => ({
      results: [
        {
          id: "abcdef123456",
          content: "Use pnpm",
          scope: "project",
          status: "active",
          pinned: true,
        },
        {
          id: "123456abcdef",
          content: "Fly",
          scope: "project",
          status: "possibly_stale",
          pinned: false,
          warning: "gone",
        },
      ],
      degraded: true,
    }));
    const out = await search(c, repo(), "install");
    expect(out).toBe(
      "abcdef12  project pinned  Use pnpm\n123456ab  project STALE  Fly (gone)\n(embeddings unavailable: keyword results only)",
    );
    expect(c.calls[0]?.[1]).toMatchObject({
      query: "install",
      project: "github.com/acme/ex",
    });
  });
  test("add sends project scope by default and user scope with --user", async () => {
    const c = fake(() => ({ id: "9", outcome: "created" }));
    expect(await add(c, repo(), "x", { pin: true })).toBe("Saved: 9");
    expect(c.calls[0]?.[1]).toMatchObject({
      scope: "project",
      pinned: true,
      project: { key: "github.com/acme/ex" },
    });
    await add(c, repo(), "y", { user: true });
    expect(c.calls[1]?.[1]).not.toHaveProperty("project");
    expect(c.calls[1]?.[1]).toMatchObject({ scope: "user" });
  });
  test("add reports duplicates", async () => {
    expect(
      await add(
        fake(() => ({ id: "9", outcome: "duplicate" })),
        repo(),
        "x",
      ),
    ).toBe("Already known: 9");
  });
  test("list and empty list", async () => {
    expect(
      await list(
        fake(() => ({ items: [] })),
        repo(),
      ),
    ).toBe("No memories yet.");
  });
  test("status summarizes server, user, project and queues", async () => {
    const c = fake((p) =>
      p === "/whoami" ? { name: "me" } : { items: [1, 2] },
    );
    expect(await status(c, repo(), "http://h")).toBe(
      "Server:    http://h\nSigned in: me\nProject:   github.com/acme/ex\nReview:    2 possibly stale\nProposals: 2 pending",
    );
  });
});

describe("config", () => {
  test("saves privately and env overrides the file", () => {
    const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "imp-cfg-")) };
    saveConfig({ url: "http://a", token: "imp_1" }, env);
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath(env), "utf8")).token).toBe(
      "imp_1",
    );
    expect(loadConfig(env)).toEqual({ url: "http://a", token: "imp_1" });
    expect(loadConfig({ ...env, IMPRESSION_TOKEN: "imp_2" }).token).toBe(
      "imp_2",
    );
    expect(loadConfig({ XDG_CONFIG_HOME: "/nonexistent" }).url).toBe(
      "http://localhost:3000",
    );
  });
});
