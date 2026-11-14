import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { memoryServes } from "./db/schema.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let token: string;
beforeAll(async () => {
  t = await createTestDb();
  app = createApp(t.db, fakeProviders());
  token = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

const call = (method: string, path: string, body?: unknown, tok = token) =>
  app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const project = { key: "github.com/acme/core" };
const add = async (content: string, extra: Record<string, unknown> = {}) =>
  (
    (await (
      await call("POST", "/memories", {
        scope: "project",
        project,
        ...extra,
        ...(extra.scope === "user" ? { project: undefined } : {}),
        content,
        dedup: false,
        ...extra,
      })
    ).json()) as { id: string }
  ).id;
const core = async (qs = "", tok = token) =>
  (await (
    await call("GET", `/core?project=${project.key}${qs}`, undefined, tok)
  ).json()) as {
    items: { id: string; content: string; pinned: boolean }[];
    tokens: number;
  };

test("pinned first, then confidence; stale and superseded are left out", async () => {
  await add("low", { confidence: 0.2 });
  await add("high", { confidence: 0.95 });
  await add("pinned one", { pinned: true, confidence: 0.1 });
  const stale = await add("stale one", { confidence: 0.99 });
  await call("PUT", `/memories/${stale}/staleness`, {
    stale: true,
    reason: "gone",
  });
  const r = await core();
  expect(r.items.map((i) => i.content)).toEqual(["pinned one", "high", "low"]);
});

test("respects the token budget", async () => {
  const long = "word ".repeat(100);
  await add(`${long}a`, { confidence: 0.99 });
  const r = await core("&budget=100");
  expect(r.tokens).toBeLessThanOrEqual(100);
  expect(r.items.every((i) => !i.content.startsWith("word"))).toBe(true);
});

test("path narrowing and user privacy", async () => {
  await add("only in api dir", { pathPrefix: "packages/api" });
  await add("mine", { scope: "user" });
  expect(
    (await core()).items.some((i) => i.content === "only in api dir"),
  ).toBe(false);
  expect(
    (await core("&path=packages/api/src")).items.some(
      (i) => i.content === "only in api dir",
    ),
  ).toBe(true);
  const bob = await createToken(t.db, "bob");
  expect((await core("", bob)).items.some((i) => i.content === "mine")).toBe(
    false,
  );
  expect((await core()).items.some((i) => i.content === "mine")).toBe(true);
});

test("logs one serve per item, with the session id when sent", async () => {
  await add("served at start", { pinned: true });
  const r = await core("&session=sess-core-1&agent=pi");
  const rows = await t.db
    .select()
    .from(memoryServes)
    .where(eq(memoryServes.sessionKey, "sess-core-1"));
  expect(rows.map((s) => s.memoryId).sort()).toEqual(
    r.items.map((i) => i.id).sort(),
  );
  expect(rows[0]).toMatchObject({
    source: "core",
    agent: "pi",
    principal: "alice",
  });
  expect(rows[0]?.projectId).toBeTruthy();
});

test("without a session, or with a malformed one, still serves and logs", async () => {
  const before = (await t.db.select().from(memoryServes)).length;
  const plain = await core();
  expect(plain.items.length).toBeGreaterThan(0);
  const long = await call(
    "GET",
    `/core?project=${project.key}&session=${"x".repeat(300)}`,
  );
  expect(long.status).toBe(200);
  const rows = await t.db.select().from(memoryServes);
  expect(rows.length).toBe(before + plain.items.length * 2);
  expect(rows.slice(before).every((s) => s.sessionKey === null)).toBe(true);
});
