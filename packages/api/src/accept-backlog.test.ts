import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { acceptBacklog } from "./accept-backlog.js";
import {
  anchors,
  memories,
  projects,
  proposals,
  sessions,
  userSettings,
} from "./db/schema.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

test("accepts pending proposals above each owner's floor and drops the rest", async () => {
  const providers = fakeProviders();
  let knownId = "";
  providers.llm = {
    model: "fake",
    complete: async ({ prompt }) =>
      prompt.includes("Deploys use flyctl deploy now")
        ? JSON.stringify({ action: "duplicate", id: knownId })
        : '{"action":"add"}',
  };
  const [project] = await t.db
    .insert(projects)
    .values({ key: "github.com/acme/backlog", name: "backlog" })
    .returning();
  const projectId = project?.id as string;
  const [alice] = await t.db
    .insert(sessions)
    .values({ projectId, owner: "alice", transcript: "a" })
    .returning();
  const [bob] = await t.db
    .insert(sessions)
    .values({ projectId, owner: "bob", transcript: "b" })
    .returning();
  // Bob keeps more than the default.
  await t.db
    .insert(userSettings)
    .values({ owner: "bob", extractionFloor: 0.5 });
  const [known] = await t.db
    .insert(memories)
    .values({
      scope: "project",
      projectId,
      owner: "alice",
      author: "alice",
      content: "Deploys use flyctl deploy",
      embedding: (
        await providers.embeddings.embed(["Deploys use flyctl deploy"])
      )[0],
    })
    .returning();
  knownId = known?.id as string;

  const add = (
    sessionId: string,
    content: string,
    confidence: number,
    practice = false,
  ) =>
    t.db.insert(proposals).values({
      projectId,
      sessionId,
      content,
      confidence,
      ...(practice ? { scope: "user" as const, tags: ["practice"] } : {}),
    });
  await add(alice?.id as string, "Run make db-migrate before tests", 0.8);
  await add(alice?.id as string, "Deploys use flyctl deploy now", 0.85);
  await add(alice?.id as string, "Maybe the cache is flaky", 0.6);
  await add(
    alice?.id as string,
    "Always open a PR, never push to main",
    0.75,
    true,
  );
  await add(bob?.id as string, "Bob's low but kept fact", 0.55);

  expect(await acceptBacklog(t.db, providers, { dryRun: true })).toMatchObject({
    toAccept: 4,
    belowFloor: 1,
    created: 0,
  });
  expect(
    await t.db.select().from(proposals).where(eq(proposals.status, "pending")),
  ).toHaveLength(5);

  expect(await acceptBacklog(t.db, providers)).toMatchObject({
    created: 3,
    duplicates: 1,
    belowFloor: 1,
    empty: 0,
    noOwner: 0,
    failed: 0,
    aborted: false,
  });
  const rows = await t.db.select().from(proposals);
  expect(rows.filter((r) => r.status === "pending")).toEqual([]);
  const low = rows.find((r) => r.content.startsWith("Maybe"));
  expect(low).toMatchObject({ status: "rejected", reviewedAt: null });
  const dup = rows.find((r) => r.content.startsWith("Deploys"));
  expect(dup?.memoryId).toBe(knownId);

  const mems = await t.db.select().from(memories);
  const practice = mems.find((m) => m.content.includes("open a PR"));
  expect(practice).toMatchObject({
    scope: "user",
    projectId: null,
    owner: "alice",
    tags: ["practice"],
  });
  const bobs = mems.find((m) => m.content.startsWith("Bob"));
  expect(bobs).toMatchObject({ projectId, agent: "extraction" });

  // A second run finds nothing left to do.
  expect(await acceptBacklog(t.db, providers)).toMatchObject({
    created: 0,
    duplicates: 0,
    belowFloor: 0,
  });
});

/** A fresh project with one session for `owner`, and a helper to queue proposals in it. */
async function backlog(key: string, owner = "carol") {
  const [project] = await t.db
    .insert(projects)
    .values({ key, name: key })
    .returning();
  const projectId = project?.id as string;
  const [session] = await t.db
    .insert(sessions)
    .values({ projectId, owner, transcript: "t" })
    .returning();
  let n = 0;
  const add = async (
    content: string,
    extra: Partial<typeof proposals.$inferInsert> = {},
  ) => {
    const [p] = await t.db
      .insert(proposals)
      .values({
        projectId,
        sessionId: session?.id,
        content,
        confidence: 0.9,
        // Oldest first, in the order they're added.
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, n++)),
        ...extra,
      })
      .returning();
    return p?.id as string;
  };
  const statusOf = async (ids: string[]) =>
    (
      await t.db
        .select({ id: proposals.id, status: proposals.status })
        .from(proposals)
        .where(inArray(proposals.id, ids))
    )
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      .map((r) => r.status);
  return { projectId, add, statusOf };
}

/** Providers whose dedup LLM always answers "add". */
function addingProviders() {
  const p = fakeProviders();
  p.llm = { model: "fake", complete: async () => '{"action":"add"}' };
  return p;
}

test("a row that fails goes back to pending and the rest carry on", async () => {
  const { projectId, add, statusOf } = await backlog("github.com/acme/fail1");
  const providers = fakeProviders();
  await t.db.insert(memories).values({
    scope: "project",
    projectId,
    owner: "carol",
    author: "carol",
    content: "Staging deploys from the staging branch",
    embedding: (
      await providers.embeddings.embed([
        "Staging deploys from the staging branch",
      ])
    )[0],
  });
  // The dedup LLM is down, so this one can't be checked against the memory above.
  providers.llm = {
    model: "fake",
    complete: async () => {
      throw new Error("LLM unavailable");
    },
  };
  const ids = [
    await add("Staging deploys from the staging branch on push"),
    await add("Payments use the stripe sandbox key in tests"),
  ];
  expect(await acceptBacklog(t.db, providers)).toMatchObject({
    created: 1,
    failed: 1,
    aborted: false,
  });
  expect(await statusOf(ids)).toEqual(["pending", "accepted"]);
  const [failed] = await t.db
    .select()
    .from(proposals)
    .where(eq(proposals.id, ids[0] as string));
  expect(failed?.memoryId).toBeNull();
  await t.db
    .update(proposals)
    .set({ status: "rejected" })
    .where(eq(proposals.id, ids[0] as string));
});

test("stops after repeated failures without adding anything unchecked", async () => {
  const { projectId, add, statusOf } = await backlog("github.com/acme/fail2");
  const ids = [];
  for (const c of ["one alpha", "two beta", "three gamma", "four delta"])
    ids.push(await add(c));
  const before = await t.db
    .select()
    .from(memories)
    .where(eq(memories.projectId, projectId));
  const r = await acceptBacklog(t.db, fakeProviders({ failEmbeddings: true }));
  expect(r).toMatchObject({ created: 0, failed: 3, aborted: true });
  expect(await statusOf(ids)).toEqual([
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  expect(
    await t.db.select().from(memories).where(eq(memories.projectId, projectId)),
  ).toEqual(before);
  // Clear them so later tests start from an empty queue.
  await t.db
    .update(proposals)
    .set({ status: "rejected" })
    .where(inArray(proposals.id, ids));
});

test("--limit takes only the oldest pending proposals", async () => {
  const { add, statusOf } = await backlog("github.com/acme/limit");
  const ids = [
    await add("Oldest fact about queues"),
    await add("Middle fact about caches"),
    await add("Newest fact about logs"),
  ];
  expect(
    await acceptBacklog(t.db, addingProviders(), { limit: 2 }),
  ).toMatchObject({ created: 2 });
  expect(await statusOf(ids)).toEqual(["accepted", "accepted", "pending"]);
  expect(await acceptBacklog(t.db, addingProviders())).toMatchObject({
    created: 1,
  });
});

test("a practice is accepted without its anchors", async () => {
  const { add } = await backlog("github.com/acme/practice");
  const id = await add("Always rebase before opening a PR", {
    scope: "user",
    tags: ["practice"],
    anchors: [{ path: "scripts/pr.sh", commitSha: "abc1234" }],
  });
  await acceptBacklog(t.db, addingProviders());
  const [p] = await t.db.select().from(proposals).where(eq(proposals.id, id));
  expect(p?.memoryId).toBeTruthy();
  expect(
    await t.db
      .select()
      .from(anchors)
      .where(eq(anchors.memoryId, p?.memoryId as string)),
  ).toEqual([]);
});
