import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { acceptBacklog } from "./accept-backlog.js";
import {
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
    accepted: 0,
  });
  expect(
    await t.db.select().from(proposals).where(eq(proposals.status, "pending")),
  ).toHaveLength(5);

  expect(await acceptBacklog(t.db, providers)).toMatchObject({
    accepted: 3,
    duplicates: 1,
    belowFloor: 1,
    empty: 0,
    noOwner: 0,
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
    accepted: 0,
    duplicates: 0,
    belowFloor: 0,
  });
});
