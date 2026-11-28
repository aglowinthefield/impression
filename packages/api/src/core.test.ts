import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { memories, memoryServes, projects, sessions } from "./db/schema.js";
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
    items: { id: string; content: string }[];
    tokens: number;
  };

test("confidence, then newest; stale and superseded are left out", async () => {
  await add("low", { confidence: 0.2 });
  await add("high", { confidence: 0.95 });
  const stale = await add("stale one", { confidence: 0.99 });
  await call("PUT", `/memories/${stale}/staleness`, {
    stale: true,
    reason: "gone",
  });
  const r = await core();
  expect(r.items.map((i) => i.content)).toEqual(["high", "low"]);
});

describe("practices", () => {
  // Carol keeps her user-scoped memories apart from the other tests' ones.
  let carol: string;
  beforeAll(async () => {
    carol = await createToken(t.db, "carol");
  });
  /** Content that costs exactly 25 tokens: 92 characters is 23, plus 2. */
  const sized = (label: string) => label.padEnd(92, ".");
  const addAs = async (tok: string, body: Record<string, unknown>) =>
    (
      (await (await call("POST", "/memories", body, tok)).json()) as {
        id: string;
      }
    ).id;
  const projectId = async (key: string) => {
    const [p] = await t.db.select().from(projects).where(eq(projects.key, key));
    if (!p) throw new Error(`no project ${key}`);
    return p.id;
  };
  /** A practice of carol's, learned in a session in `key`'s project. */
  const practiceFrom = async (key: string, content: string) => {
    const id = await addAs(carol, {
      scope: "user",
      tags: ["practice"],
      content,
      confidence: 0.99,
      dedup: false,
    });
    const [s] = await t.db
      .insert(sessions)
      .values({
        projectId: await projectId(key),
        owner: "carol",
        transcript: "",
      })
      .returning();
    await t.db
      .update(memories)
      .set({ sessionId: s?.id })
      .where(eq(memories.id, id));
    return id;
  };
  const facts = async (key: string, n: number) => {
    for (let i = 0; i < n; i++)
      await addAs(carol, {
        scope: "project",
        project: { key },
        content: sized(`${key} fact ${i}`),
        dedup: false,
      });
  };
  const coreAs = async (key: string, budget: number) =>
    (await (
      await call(
        "GET",
        `/core?project=${key}&budget=${budget}`,
        undefined,
        carol,
      )
    ).json()) as {
      items: { content: string; tags: string[] }[];
      tokens: number;
    };
  const split = (r: Awaited<ReturnType<typeof coreAs>>) => ({
    practices: r.items.filter((i) => i.tags.includes("practice")).length,
    others: r.items.filter((i) => !i.tags.includes("practice")).length,
  });

  test("take at most a quarter of the budget when other memories fill the rest", async () => {
    const key = "github.com/acme/share";
    await facts(key, 10);
    for (let i = 0; i < 5; i++)
      await practiceFrom(key, sized(`share practice ${i}`));
    const r = await coreAs(key, 200);
    // 25 tokens each: the others get 150, practices the 50 left.
    expect(split(r)).toEqual({ practices: 2, others: 6 });
    expect(r.tokens).toBe(200);
  });

  test("may use room the other memories leave unused", async () => {
    const key = "github.com/acme/roomy";
    await facts(key, 2);
    for (let i = 0; i < 5; i++)
      await practiceFrom(key, sized(`roomy practice ${i}`));
    expect(split(await coreAs(key, 200))).toEqual({ practices: 5, others: 2 });
  });

  test("other memories take room practices don't need", async () => {
    const key = "github.com/acme/sparse";
    await facts(key, 10);
    await practiceFrom(key, sized("sparse practice"));
    expect(split(await coreAs(key, 200))).toEqual({ practices: 1, others: 7 });
  });

  test("many practices can't push the other memories out of the set", async () => {
    const key = "github.com/acme/crowd";
    await facts(key, 1);
    // More confident practices than one ranked query would read.
    for (let i = 0; i < 201; i++)
      await practiceFrom(key, `crowd practice ${i}`);
    expect(split(await coreAs(key, 200)).others).toBe(1);
  });

  test("only those learned in a session in this project are served", async () => {
    const here = "github.com/acme/here";
    const there = "github.com/acme/there";
    await facts(here, 1);
    await facts(there, 1);
    await practiceFrom(here, "learned here");
    await practiceFrom(there, "learned elsewhere");
    // A practice with no session behind it fits no project.
    await addAs(carol, {
      scope: "user",
      tags: ["practice"],
      content: "learned nowhere",
      dedup: false,
    });
    const served = (await coreAs(here, 2000)).items
      .filter((i) => i.tags.includes("practice"))
      .map((i) => i.content);
    expect(served).toEqual(["learned here"]);
  });
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
  await add("served at start");
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
