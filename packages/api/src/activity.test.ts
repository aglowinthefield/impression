import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Entry } from "./activity.js";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import {
  dreamRuns,
  memories,
  memoryEvents,
  projects,
  sessions,
} from "./db/schema.js";
import { createMemory } from "./memories.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let alice: string;
let bob: string;
/** What the dedup check answers next. */
let verdict = "";
const providers = fakeProviders();
providers.llm = { model: "fake", complete: async () => verdict };

const KEY = "github.com/acme/act";

beforeAll(async () => {
  t = await createTestDb();
  app = createApp(t.db, providers);
  alice = await createToken(t.db, "alice");
  bob = await createToken(t.db, "bob");
});
afterAll(() => t.drop());

async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function add(content: string, key = KEY, token = alice) {
  verdict = '{"action":"add"}';
  const r = await call(token, "POST", "/memories", {
    scope: "project",
    project: { key },
    content,
  });
  return r.json as { id: string };
}

async function list(token = alice, query = "", key = KEY) {
  const r = await call(
    token,
    "GET",
    `/activity?project=${encodeURIComponent(key)}${query}`,
  );
  expect(r.status).toBe(200);
  return r.json as { items: Entry[]; next: string | null };
}

const entryFor = async (memoryId: string, kind: string, token = alice) =>
  (await list(token)).items.find(
    (e) => e.memory?.id === memoryId && e.kind === kind,
  ) as Entry;

const status = async (id: string) =>
  (await t.db.select().from(memories).where(eq(memories.id, id)))[0];

describe("entries", () => {
  test("extraction names its session and agent", async () => {
    const [p] = await t.db
      .insert(projects)
      .values({ key: KEY, name: "act" })
      .onConflictDoNothing()
      .returning();
    const projectId =
      p?.id ??
      (await t.db.select().from(projects).where(eq(projects.key, KEY)))[0]?.id;
    const [s] = await t.db
      .insert(sessions)
      .values({
        projectId: projectId as string,
        owner: "alice",
        agent: "pi",
        transcript: "x",
      })
      .returning();
    verdict = '{"action":"add"}';
    const r = await createMemory(t.db, providers, "alice", {
      scope: "project",
      project: { key: KEY },
      content: "Extraction learned that builds run with tsrs",
      agent: "extraction",
      sessionId: s?.id,
      dedup: true,
      tags: [],
      anchors: [],
    });
    const id = (r.body as { id: string }).id;
    const e = await entryFor(id, "extracted");
    expect(e).toMatchObject({
      actor: "extraction",
      session: { id: s?.id, agent: "pi" },
      memory: { content: "Extraction learned that builds run with tsrs" },
      canUndo: true,
      undone: false,
    });
  });

  test("a merge shows the text before and after, and undo restores it", async () => {
    const m = await add("Deploys go through fly deploy");
    verdict = JSON.stringify({
      action: "duplicate",
      id: m.id,
      merged: "Deploys go through fly deploy with --remote-only",
    });
    await call(alice, "POST", "/memories", {
      scope: "project",
      project: { key: KEY },
      content: "Deploys go through fly deploy --remote-only",
    });
    const e = await entryFor(m.id, "merged");
    expect(e).toMatchObject({
      before: "Deploys go through fly deploy",
      after: "Deploys go through fly deploy with --remote-only",
    });
    const u = await call(alice, "POST", `/activity/${e.id}/undo`);
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ kind: "undone", undoes: "merged" });
    expect((await status(m.id))?.content).toBe("Deploys go through fly deploy");
    expect(await entryFor(m.id, "merged")).toMatchObject({
      undone: true,
      canUndo: false,
    });
    expect((await call(alice, "POST", `/activity/${e.id}/undo`)).status).toBe(
      409,
    );
  });

  test("undoing a supersede brings the old memory back and retires the new one", async () => {
    const old = await add("The queue runs on Redis");
    verdict = JSON.stringify({ action: "supersede", ids: [old.id] });
    const r = await call(alice, "POST", "/memories", {
      scope: "project",
      project: { key: KEY },
      content: "The queue runs on Postgres now",
    });
    const fresh = r.json as { id: string };
    expect((await status(old.id))?.status).toBe("superseded");
    const e = await entryFor(fresh.id, "superseded");
    expect(e.before).toBe("The queue runs on Redis");
    expect((await call(alice, "POST", `/activity/${e.id}/undo`)).status).toBe(
      200,
    );
    expect(await status(old.id)).toMatchObject({
      status: "active",
      supersededBy: null,
    });
    expect((await status(fresh.id))?.status).toBe("retired");
  });

  test("edits and retires by a person, and their undos", async () => {
    const m = await add("Lint runs biome");
    await call(alice, "PATCH", `/memories/${m.id}`, {
      content: "Lint runs biome check",
    });
    const edit = await entryFor(m.id, "edited");
    expect(edit).toMatchObject({
      actor: "person",
      principal: "alice",
      before: "Lint runs biome",
      after: "Lint runs biome check",
    });
    await call(alice, "DELETE", `/memories/${m.id}`);
    // The retire came later, so the edit can't be undone under it.
    const refused = await call(alice, "POST", `/activity/${edit.id}/undo`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/changed since/);
    const retire = await entryFor(m.id, "retired");
    expect(
      (await call(alice, "POST", `/activity/${retire.id}/undo`)).status,
    ).toBe(200);
    expect((await status(m.id))?.status).toBe("active");
    // With the retire undone, the edit is the latest change again.
    expect(
      (await call(alice, "POST", `/activity/${edit.id}/undo`)).status,
    ).toBe(200);
    expect((await status(m.id))?.content).toBe("Lint runs biome");
  });

  test("undoing an extraction retires the memory", async () => {
    const m = await add("Tests need Docker running");
    const e = await entryFor(m.id, "added");
    expect((await call(alice, "POST", `/activity/${e.id}/undo`)).status).toBe(
      200,
    );
    expect((await status(m.id))?.status).toBe("retired");
  });

  test("a staleness check retire and its undo", async () => {
    const m = await add("Checked memory");
    await t.db.insert(memoryEvents).values({
      memoryId: m.id,
      kind: "retired",
      actor: "check",
      principal: "alice",
      reason: "src/a.ts changed",
      detail: { previous: { status: "possibly_stale", staleReason: "x" } },
    });
    await t.db
      .update(memories)
      .set({ status: "retired" })
      .where(eq(memories.id, m.id));
    const e = await entryFor(m.id, "retired");
    expect(e).toMatchObject({ actor: "check", reason: "src/a.ts changed" });
    await call(alice, "POST", `/activity/${e.id}/undo`);
    expect(await status(m.id)).toMatchObject({
      status: "possibly_stale",
      staleReason: "x",
    });
  });

  test("a check keep has no undo", async () => {
    const m = await add("Kept memory");
    await t.db.insert(memoryEvents).values({
      memoryId: m.id,
      kind: "kept",
      actor: "check",
      principal: "alice",
      reason: "r",
    });
    const e = await entryFor(m.id, "kept");
    expect(e.canUndo).toBe(false);
    expect((await call(alice, "POST", `/activity/${e.id}/undo`)).status).toBe(
      400,
    );
  });
});

describe("who sees what", () => {
  test("others see a shared memory's entries without undo, and never a private one", async () => {
    const shared = await add("Shared note about ports");
    const secret = await add("Private note about tokens");
    await call(alice, "PATCH", `/memories/${shared.id}`, { scope: "team" });
    const bobs = (await list(bob)).items;
    expect(bobs.some((e) => e.memory?.id === secret.id)).toBe(false);
    const e = bobs.find((x) => x.memory?.id === shared.id) as Entry;
    expect(e.canUndo).toBe(false);
    expect((await call(bob, "POST", `/activity/${e.id}/undo`)).status).toBe(
      403,
    );
    const hidden = (await list(alice)).items.find(
      (x) => x.memory?.id === secret.id,
    ) as Entry;
    expect(
      (await call(bob, "POST", `/activity/${hidden.id}/undo`)).status,
    ).toBe(404);
  });

  test("a shared memory's entry hides the private text it replaced", async () => {
    const old = await add("Staging secrets live in the private vault");
    verdict = JSON.stringify({ action: "supersede", ids: [old.id] });
    const r = await call(alice, "POST", "/memories", {
      scope: "project",
      project: { key: KEY },
      content: "Staging secrets live in Doppler now",
    });
    const fresh = r.json as { id: string };
    await call(alice, "PATCH", `/memories/${fresh.id}`, { scope: "team" });
    const e = (await list(bob)).items.find(
      (x) => x.memory?.id === fresh.id,
    ) as Entry;
    expect(e.kind).toBe("superseded");
    expect(e.before).toBeUndefined();
  });

  test("dream runs show only for their owner", async () => {
    const [p] = await t.db.select().from(projects).where(eq(projects.key, KEY));
    await t.db.insert(dreamRuns).values({
      projectId: p?.id as string,
      owner: "alice",
      trigger: "count",
      model: "fake",
      finishedAt: new Date(),
      concepts: 4,
      created: 1,
      kept: 3,
      removed: 0,
      uncategorized: 2,
    });
    const run = (await list(alice, "&source=dream")).items;
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      kind: "dreamed",
      run: { created: 1, kept: 3, removed: 0, uncategorized: 2 },
      canUndo: false,
    });
    expect((await list(bob, "&source=dream")).items).toHaveLength(0);
  });
});

describe("list", () => {
  test("filters by source and pages 50 at a time without repeats", async () => {
    const key = "github.com/acme/many";
    for (let i = 0; i < 55; i++) await add(`Note number ${i} for paging`, key);
    const first = await list(alice, "", key);
    expect(first.items).toHaveLength(50);
    expect(first.next).toBeTruthy();
    const second = await list(
      alice,
      `&before=${encodeURIComponent(first.next as string)}`,
      key,
    );
    expect(second.items).toHaveLength(5);
    expect(second.next).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((e) => e.id));
    expect(ids.size).toBe(55);
    expect((await list(alice, "&source=extraction", key)).items).toHaveLength(
      0,
    );
    expect((await list(alice, "&source=person", key)).items).toHaveLength(50);
  });

  test("the summary counts four weeks and the retire rate", async () => {
    const key = "github.com/acme/sum";
    const a = await add("Sum one", key);
    await add("Sum two", key);
    await call(alice, "DELETE", `/memories/${a.id}`);
    const r = await call(
      alice,
      "GET",
      `/activity/summary?project=${encodeURIComponent(key)}`,
    );
    expect(r.json.weeks).toHaveLength(4);
    expect(r.json.weeks[0]).toMatchObject({
      added: 2,
      retired: 1,
      retireRate: 50,
    });
    expect(r.json.weeks[1]).toMatchObject({ added: 0, retireRate: null });
  });

  test("the retire rate is the share of a week's additions retired since", async () => {
    const key = "github.com/acme/cohort";
    const old = await add("Added a while back", key);
    await t.db
      .update(memoryEvents)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) })
      .where(eq(memoryEvents.memoryId, old.id));
    await call(alice, "DELETE", `/memories/${old.id}`);
    const r = await call(
      alice,
      "GET",
      `/activity/summary?project=${encodeURIComponent(key)}`,
    );
    // Retired this week, but it was added the week before.
    expect(r.json.weeks[0]).toMatchObject({
      added: 0,
      retired: 1,
      retireRate: null,
    });
    expect(r.json.weeks[1]).toMatchObject({
      added: 1,
      retired: 0,
      retireRate: 100,
    });
  });

  test("without a project, lists and counts every project you can see", async () => {
    const one = await add("All one", "github.com/acme/all-1");
    const two = await add("All two", "github.com/acme/all-2");
    const hidden = await add("Bob's own", "github.com/acme/all-3", bob);
    const r = await call(alice, "GET", "/activity");
    expect(r.status).toBe(200);
    const ids = (r.json.items as Entry[]).map((e) => e.memory?.id);
    expect(ids).toContain(one.id);
    expect(ids).toContain(two.id);
    expect(ids).not.toContain(hidden.id);
    const one1 = await call(
      alice,
      "GET",
      `/activity/summary?project=${encodeURIComponent("github.com/acme/all-1")}`,
    );
    const all = await call(alice, "GET", "/activity/summary");
    expect(all.status).toBe(200);
    expect(all.json.weeks[0].added).toBeGreaterThan(one1.json.weeks[0].added);
  });
});
