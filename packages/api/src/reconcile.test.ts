import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { memories } from "./db/schema.js";
import { parseVerdict } from "./reconcile.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

const cands = [
  { id: "a", content: "x" },
  { id: "b", content: "y" },
];

describe("parseVerdict", () => {
  test("reads JSON wrapped in prose or fences", () => {
    expect(
      parseVerdict(
        'Sure:\n```json\n{"action":"supersede","ids":["a"]}\n```',
        cands,
      ),
    ).toEqual({
      action: "supersede",
      ids: ["a"],
    });
  });
  test("drops unknown ids", () => {
    expect(
      parseVerdict('{"action":"supersede","ids":["zzz","b"]}', cands),
    ).toEqual({
      action: "supersede",
      ids: ["b"],
    });
    expect(parseVerdict('{"action":"duplicate","id":"zzz"}', cands)).toEqual({
      action: "add",
    });
  });
  test.each([
    "",
    "no json",
    "{bad",
    '{"action":"delete"}',
    '{"action":"supersede","ids":[]}',
  ])("treats %j as add", (r) =>
    expect(parseVerdict(r, cands)).toEqual({ action: "add" }),
  );
});

let t: Awaited<ReturnType<typeof createTestDb>>;
let alice: string;
const proj = { key: "github.com/acme/dedup" };
let reply = '{"action":"add"}';
let llmCalls = 0;
let llmFails = false;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestDb();
  const providers = fakeProviders();
  providers.llm = {
    model: "fake",
    complete: async () => {
      llmCalls++;
      if (llmFails) throw new Error("llm down");
      return reply;
    },
  };
  app = createApp(t.db, providers);
  alice = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

const post = async (body: Record<string, unknown>) => {
  const res = await app.request("/api/memories", {
    method: "POST",
    headers: {
      authorization: `Bearer ${alice}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scope: "project", project: proj, ...body }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

describe("dedup on create", () => {
  test("the first memory skips the LLM (no candidates)", async () => {
    llmCalls = 0;
    const r = await post({ content: "tests run with pnpm test" });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe("created");
    expect(llmCalls).toBe(0);
  });

  test("a duplicate returns the existing memory and creates nothing", async () => {
    const [orig] = await t.db
      .select()
      .from(memories)
      .where(eq(memories.content, "tests run with pnpm test"));
    reply = JSON.stringify({ action: "duplicate", id: orig?.id });
    const r = await post({ content: "tests run with pnpm test please" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      outcome: "duplicate",
      id: orig?.id,
      content: "tests run with pnpm test",
    });
    expect(await t.db.select().from(memories)).toHaveLength(1);
  });

  test("a duplicate with merged text updates and re-embeds the existing memory", async () => {
    const [orig] = await t.db.select().from(memories);
    reply = JSON.stringify({
      action: "duplicate",
      id: orig?.id,
      merged: "tests run with pnpm test, needs Postgres",
    });
    const r = await post({
      content: "tests run with pnpm test and need Postgres",
    });
    expect(r.body).toMatchObject({
      outcome: "merged",
      content: "tests run with pnpm test, needs Postgres",
    });
    expect(await t.db.select().from(memories)).toHaveLength(1);
  });

  test("a contradiction supersedes the old memory and keeps it as history", async () => {
    const [old] = await t.db.select().from(memories);
    reply = JSON.stringify({ action: "supersede", ids: [old?.id] });
    const r = await post({
      content: "tests run with pnpm test:all, needs Postgres",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      outcome: "superseded",
      supersedes: [old?.id],
    });
    const [row] = await t.db
      .select()
      .from(memories)
      .where(eq(memories.id, old?.id as string));
    expect(row).toMatchObject({
      status: "superseded",
      supersededBy: r.body.id,
    });
  });

  test("superseded memories are not offered as candidates again", async () => {
    llmCalls = 0;
    reply = '{"action":"add"}';
    await post({ content: "tests run with pnpm test:all" });
    // Only the new active memory is a candidate, so the LLM was asked once.
    expect(llmCalls).toBe(1);
  });

  test("an unrelated memory is added", async () => {
    const r = await post({ content: "zebra stripes quokka narwhal" });
    expect(r.body.outcome).toBe("created");
  });

  test("an LLM failure still saves the memory", async () => {
    llmFails = true;
    const r = await post({
      content: "tests run with pnpm test:all and docker",
    });
    llmFails = false;
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe("created");
  });

  test("dedup:false skips the check", async () => {
    llmCalls = 0;
    const r = await post({
      content: "tests run with pnpm test:all again",
      dedup: false,
    });
    expect(r.body.outcome).toBe("created");
    expect(llmCalls).toBe(0);
  });

  test("project memories in another project are not candidates", async () => {
    llmCalls = 0;
    await post({
      content: "tests run with pnpm test:all",
      project: { key: "github.com/acme/else" },
    });
    expect(llmCalls).toBe(0);
  });
});
