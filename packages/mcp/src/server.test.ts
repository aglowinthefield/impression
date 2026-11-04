import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createServer } from "./server.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "imp-mcp-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  git("init", "-q");
  git("remote", "add", "origin", "git@github.com:acme/ex.git");
  return dir;
}

async function connect(post: (path: string, body: unknown) => unknown) {
  const calls: { path: string; body: unknown }[] = [];
  const server = createServer({
    client: {
      get: async (path) => {
        calls.push({ path, body: undefined });
        return post(path, undefined);
      },
      post: async (path, body) => {
        calls.push({ path, body });
        return post(path, body);
      },
    },
    cwd: repo(),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
  return { call, calls };
}

describe("mcp tools", () => {
  test("search sends the project key and lists results with stale warnings", async () => {
    const { call, calls } = await connect(() => ({
      results: [
        { id: "1", content: "Use pnpm", warning: null },
        { id: "2", content: "Fly deploy", warning: "May be out of date: gone" },
      ],
    }));
    const r = await call("search", { query: "how to install" });
    expect(calls[0]).toMatchObject({
      path: "/search",
      body: { query: "how to install", project: "github.com/acme/ex" },
    });
    expect(r.content[0]?.text).toBe(
      "- Use pnpm [1]\n- Fly deploy (May be out of date: gone) [2]",
    );
  });

  test("search with no hits says so", async () => {
    const { call } = await connect(() => ({ results: [] }));
    expect((await call("search", { query: "x" })).content[0]?.text).toBe(
      "No matching memories.",
    );
  });

  test("add saves a project memory and reports duplicates", async () => {
    const { call, calls } = await connect(() => ({
      id: "9",
      outcome: "duplicate",
    }));
    const r = await call("add", { content: "Use pnpm" });
    expect(calls[0]).toMatchObject({
      path: "/memories",
      body: {
        scope: "project",
        content: "Use pnpm",
        project: { key: "github.com/acme/ex", name: "ex" },
        agent: "mcp",
      },
    });
    expect(r.content[0]?.text).toBe("Already known, nothing added. [9]");
  });

  test("API errors come back as tool errors", async () => {
    const { call } = await connect(() => {
      throw new Error("Impression API 401: invalid token");
    });
    const r = await call("search", { query: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("401");
  });
});
