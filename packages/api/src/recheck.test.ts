import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { anchors, memories, memoryEvents, usageEvents } from "./db/schema.js";
import { excerpts, type FileState, parseRecheck } from "./recheck.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";
import { UsageRecorder } from "./usage.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let alice: string;
let bob: string;
let usage: UsageRecorder;
/** What the fake model answers next. A function lets a test throw or capture the prompt. */
let reply: (prompt: string) => string = () => "";
const prompts: string[] = [];

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const project = { key: "github.com/acme/recheck" };

beforeAll(async () => {
  t = await createTestDb();
  usage = new UsageRecorder(t.db);
  const providers = fakeProviders();
  providers.llm = {
    model: "fake",
    async complete(req) {
      prompts.push(req.prompt);
      const out = reply(req.prompt);
      usage.record({
        kind: "completion",
        provider: "anthropic",
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
      });
      return out;
    },
  };
  app = createApp(t.db, providers);
  alice = await createToken(t.db, "alice");
  bob = await createToken(t.db, "bob");
});
afterAll(() => t.drop());

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(`/api/memories${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function anchored(content: string, extra: Record<string, unknown> = {}) {
  const res = await call(alice, "POST", "", {
    scope: "project",
    project,
    content,
    dedup: false,
    tags: ["api"],
    anchors: [
      { path: "src/a.ts", symbol: "foo", commitSha: OLD },
      { path: "src/gone.ts", commitSha: OLD },
    ],
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

const body = (
  files: FileState[] = [{ path: "src/a.ts", content: "export const bar = 1" }],
) => ({
  reason: "foo is no longer in src/a.ts",
  commitSha: NEW,
  files,
});

const events = (id: string) =>
  t.db.select().from(memoryEvents).where(eq(memoryEvents.memoryId, id));

describe("recheck", () => {
  test("keep moves the anchors to the new commit and clears the stale flag", async () => {
    const id = await anchored("The config lives in src/a.ts as foo");
    await call(alice, "PUT", `/${id}/staleness`, { stale: true, reason: "x" });
    reply = () => 'Sure: {"action":"keep"}';
    const res = await call(
      alice,
      "POST",
      `/${id}/recheck`,
      body([
        { path: "src/a.ts", content: "export const foo = 2" },
        { path: "src/gone.ts", content: null },
      ]),
    );
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.outcome).toBe("kept");
    expect(r.memory.status).toBe("active");
    expect(r.memory.staleReason).toBeNull();
    // The deleted file's anchor is dropped, the other one moves.
    expect(r.memory.anchors).toEqual([
      expect.objectContaining({ path: "src/a.ts", commitSha: NEW }),
    ]);
    expect(await events(id)).toMatchObject([
      {
        kind: "kept",
        reason: "foo is no longer in src/a.ts",
        detail: { commitSha: NEW, files: ["src/a.ts", "src/gone.ts"] },
      },
    ]);
    expect(prompts.at(-1)).toContain("--- src/gone.ts (deleted)");
  });

  test("rewrite supersedes the memory with a new one at the new commit", async () => {
    const id = await anchored("Settings are read from foo in src/a.ts", {
      pinned: true,
      pathPrefix: "src",
    });
    reply = () =>
      JSON.stringify({
        action: "rewrite",
        content: "Settings are read from bar in src/a.ts",
      });
    const res = await call(alice, "POST", `/${id}/recheck`, body());
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.outcome).toBe("rewritten");
    expect(r.memory).toMatchObject({
      status: "superseded",
      supersededBy: r.replacement.id,
    });
    expect(r.replacement).toMatchObject({
      content: "Settings are read from bar in src/a.ts",
      status: "active",
      scope: "project",
      project: project.key,
      tags: ["api"],
      pinned: true,
      pathPrefix: "src",
      owner: "alice",
    });
    expect(
      r.replacement.anchors.map((a: { path: string; commitSha: string }) => [
        a.path,
        a.commitSha,
      ]),
    ).toEqual([
      ["src/a.ts", NEW],
      ["src/gone.ts", NEW],
    ]);
    expect(await events(id)).toMatchObject([
      {
        kind: "rewritten",
        detail: { replacement: r.replacement.id, commitSha: NEW },
      },
    ]);
  });

  test("rewrite keeps a team memory shared", async () => {
    const id = await anchored("Team fact about foo");
    await call(alice, "PATCH", `/${id}`, { scope: "team" });
    reply = () => '{"action":"rewrite","content":"Team fact about bar"}';
    const r = await (
      await call(alice, "POST", `/${id}/recheck`, body())
    ).json();
    expect(r.replacement.scope).toBe("team");
  });

  test("retire retires the memory", async () => {
    const id = await anchored("foo is exported from src/a.ts");
    reply = () => '{"action":"retire","why":"foo was removed"}';
    const res = await call(alice, "POST", `/${id}/recheck`, body());
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.outcome).toBe("retired");
    expect(r.memory.status).toBe("retired");
    expect(await events(id)).toMatchObject([
      { kind: "retired", detail: { why: "foo was removed" } },
    ]);
  });

  test.each([
    ["an unparseable reply", () => "I think it is probably fine"],
    [
      "a model error",
      () => {
        throw new Error("model down");
      },
    ],
  ])("%s changes nothing and returns an error", async (_name, fn) => {
    const id = await anchored("foo still matters");
    reply = fn;
    const res = await call(alice, "POST", `/${id}/recheck`, body());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/recheck failed/);
    const [m] = await t.db.select().from(memories).where(eq(memories.id, id));
    expect(m?.status).toBe("active");
    const as = await t.db
      .select()
      .from(anchors)
      .where(eq(anchors.memoryId, id));
    expect(as.every((a) => a.commitSha === OLD)).toBe(true);
    expect(await events(id)).toEqual([]);
  });

  test("tags model usage with the recheck operation", async () => {
    const id = await anchored("usage check on foo");
    reply = () => '{"action":"keep"}';
    await call(alice, "POST", `/${id}/recheck`, body());
    await usage.flush();
    const rows = await t.db.select().from(usageEvents);
    expect(rows.at(-1)).toMatchObject({
      operation: "recheck",
      principal: "alice",
    });
  });

  test("only the author can recheck, and only a live memory", async () => {
    const id = await anchored("private foo");
    reply = () => '{"action":"retire"}';
    expect((await call(bob, "POST", `/${id}/recheck`, body())).status).toBe(
      404,
    );
    await call(alice, "PATCH", `/${id}`, { scope: "team" });
    expect((await call(bob, "POST", `/${id}/recheck`, body())).status).toBe(
      403,
    );
    await call(alice, "DELETE", `/${id}`);
    expect((await call(alice, "POST", `/${id}/recheck`, body())).status).toBe(
      409,
    );
  });

  test.each([
    ["no files", { ...body(), files: [] }],
    ["a bad sha", { ...body(), commitSha: "main" }],
    [
      "a path outside the repo",
      body([{ path: "../etc/passwd", content: "x" }]),
    ],
  ])("rejects %s", async (_name, b) => {
    const id = await anchored("validation foo");
    expect((await call(alice, "POST", `/${id}/recheck`, b)).status).toBe(400);
  });
});

describe("anchored", () => {
  test("lists your live anchored memories in the project with their anchors", async () => {
    const other = { key: "github.com/acme/anchored" };
    const mk = async (token: string, extra: Record<string, unknown>) =>
      (
        await (
          await call(token, "POST", "", {
            scope: "project",
            project: other,
            dedup: false,
            ...extra,
          })
        ).json()
      ).id as string;
    const mine = await mk(alice, {
      content: "anchored one",
      anchors: [{ path: "x.ts", commitSha: OLD }],
    });
    await mk(alice, { content: "no anchors" });
    const retired = await mk(alice, {
      content: "retired one",
      anchors: [{ path: "x.ts", commitSha: OLD }],
    });
    await call(alice, "DELETE", `/${retired}`);
    await mk(bob, {
      content: "bob's",
      anchors: [{ path: "x.ts", commitSha: OLD }],
    });

    const r = await (
      await call(alice, "GET", `/anchored?project=${other.key}`)
    ).json();
    expect(r.items.map((i: { id: string }) => i.id)).toEqual([mine]);
    expect(r.items[0].anchors).toEqual([
      expect.objectContaining({ path: "x.ts", commitSha: OLD }),
    ]);
    expect(
      (await (await call(alice, "GET", "/anchored?project=nope")).json()).items,
    ).toEqual([]);
    expect((await call(alice, "GET", "/anchored")).status).toBe(400);
  });
});

describe("excerpts", () => {
  test("short files are whole and long ones share what is left", () => {
    const out = excerpts(
      [
        { path: "long", content: "x".repeat(100) },
        { path: "short", content: "y".repeat(10) },
        { path: "gone", content: null },
      ],
      50,
    );
    expect(out[1]).toBe(`--- short\n${"y".repeat(10)}`);
    expect(out[0]).toBe(
      `--- long\n${"x".repeat(40)}\n[... 60 more characters not shown]`,
    );
    expect(out[2]).toBe("--- gone (deleted)");
  });

  test("parseRecheck rejects anything that isn't a verdict", () => {
    expect(parseRecheck('{"action":"rewrite"}')).toBeNull();
    expect(parseRecheck('{"action":"delete"}')).toBeNull();
    expect(parseRecheck('x {"action":"retire"} y')).toEqual({
      action: "retire",
    });
  });
});
