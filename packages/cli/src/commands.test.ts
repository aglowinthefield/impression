import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  accept,
  add,
  edit,
  keep,
  list,
  proposals,
  reject,
  retire,
  search,
  status,
} from "./commands.js";
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
  const call = async (m: string, p: string, b?: unknown) => {
    calls.push([m === "GET" ? p : `${m} ${p}`, b]);
    return reply(p);
  };
  return {
    calls,
    get: (p: string) => call("GET", p),
    post: (p: string, b: unknown) => call("POST", p, b),
    patch: (p: string, b: unknown) => call("PATCH", p, b),
    put: (p: string, b: unknown) => call("PUT", p, b),
    delete: (p: string) => call("DELETE", p),
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

describe("review commands", () => {
  const ID = "abcdef12-0000-4000-8000-000000000001";
  const OTHER = "abcdef99-0000-4000-8000-000000000002";
  const mem = (id: string) => ({
    id,
    content: "x",
    scope: "project",
    status: "active",
    pinned: false,
  });
  const reply = (p: string) =>
    p.startsWith("/proposals?")
      ? { items: [{ id: ID, content: "Use pnpm", confidence: 0.8 }] }
      : p === "/memories/review"
        ? { items: [] }
        : p.startsWith("/memories?")
          ? { items: [mem(ID), mem(OTHER)] }
          : { id: ID };

  test("proposals lists pending with short ids", async () => {
    const c = fake(reply);
    expect(await proposals(c, repo())).toBe("abcdef12  0.80  Use pnpm");
    expect(c.calls[0]?.[0]).toContain("project=github.com%2Facme%2Fex");
  });

  test("accept resolves a prefix and sends edited text", async () => {
    const c = fake(reply);
    expect(await accept(c, repo(), "abcdef12", "Use pnpm 12")).toBe(
      `Accepted: ${ID}`,
    );
    expect(c.calls.at(-1)).toEqual([
      `POST /proposals/${ID}/accept`,
      { content: "Use pnpm 12" },
    ]);
  });

  test("reject posts to the proposal", async () => {
    const c = fake(reply);
    await reject(c, repo(), "abcdef12");
    expect(c.calls.at(-1)?.[0]).toBe(`POST /proposals/${ID}/reject`);
  });

  test("retire, edit and keep resolve memory prefixes", async () => {
    const c = fake(reply);
    await retire(c, repo(), "abcdef12");
    expect(c.calls.at(-1)?.[0]).toBe(`DELETE /memories/${ID}`);
    await edit(c, repo(), "abcdef12", "new text");
    expect(c.calls.at(-1)).toEqual([
      `PATCH /memories/${ID}`,
      { content: "new text" },
    ]);
    await keep(c, repo(), "abcdef12");
    expect(c.calls.at(-1)).toEqual([
      `PUT /memories/${ID}/staleness`,
      { stale: false },
    ]);
  });

  test("ambiguous and unknown prefixes are errors; full uuids skip lookup", async () => {
    const c = fake(reply);
    await expect(retire(c, repo(), "abcdef")).rejects.toThrow(
      /matches 2 memory entries/,
    );
    await expect(retire(c, repo(), "ffff")).rejects.toThrow(
      /No memory starts with ffff/,
    );
    const n = c.calls.length;
    await retire(c, repo(), OTHER);
    expect(c.calls.length).toBe(n + 1);
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
    expect(loadConfig(env)).toEqual({
      url: "http://a",
      token: "imp_1",
      sendInstructions: false,
    });
    // Re-login keeps the option; the env var overrides it.
    writeFileSync(
      configPath(env),
      JSON.stringify({ url: "http://a", sendInstructions: true }),
    );
    saveConfig({ url: "http://b", token: "imp_3" }, env);
    expect(loadConfig(env).sendInstructions).toBe(true);
    expect(
      loadConfig({ ...env, IMPRESSION_SEND_INSTRUCTIONS: "0" })
        .sendInstructions,
    ).toBe(false);
    expect(loadConfig({ ...env, IMPRESSION_TOKEN: "imp_2" }).token).toBe(
      "imp_2",
    );
    expect(loadConfig({ XDG_CONFIG_HOME: "/nonexistent" }).url).toBe(
      "https://impression.quest",
    );
  });
});
