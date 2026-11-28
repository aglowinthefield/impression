import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Access } from "./access.js";
import { backfillSpentMicros } from "./backfill.js";
import {
  memories,
  projects,
  sessions,
  usageEvents,
  users,
} from "./db/schema.js";
import { renameOwner } from "./owner-rename.js";
import { createTestDb } from "./test-db.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

test("moves backfill spend and keeps one copy of a piece both names stored", async () => {
  const [p] = await t.db
    .insert(projects)
    .values({ key: "github.com/acme/handover", name: "handover" })
    .returning();
  const projectId = p?.id as string;
  const [user] = await t.db
    .insert(users)
    .values({ githubId: 4242, login: "tomgh" })
    .returning();
  const piece = (owner: string, hash: string, extracted: boolean) =>
    t.db
      .insert(sessions)
      .values({
        projectId,
        owner,
        transcript: `piece ${hash}`,
        source: "backfill",
        pieceHash: hash,
        extractedAt: extracted ? new Date() : null,
      })
      .returning()
      .then((r) => r[0]?.id as string);
  // Only the old name extracted x; neither extracted y; z is the old name's alone.
  const oldX = await piece("tomtok", "x", true);
  await piece("tomgh", "x", false);
  const oldY = await piece("tomtok", "y", false);
  const newY = await piece("tomgh", "y", false);
  const oldZ = await piece("tomtok", "z", false);
  const [m] = await t.db
    .insert(memories)
    .values({
      scope: "project",
      projectId,
      owner: "tomtok",
      author: "tomtok",
      content: "from the old name's copy of y",
      sessionId: oldY,
    })
    .returning();
  await t.db.insert(usageEvents).values({
    principal: "tomtok",
    operation: "backfill",
    kind: "completion",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    inputTokens: 1,
    outputTokens: 1,
    costMicros: 20_000,
  });

  const moved = await renameOwner(t.db, "tomtok", "tomgh");
  expect(moved.usageEvents).toBe(1);

  const kept = await t.db
    .select({ id: sessions.id, hash: sessions.pieceHash })
    .from(sessions)
    .where(eq(sessions.owner, "tomgh"));
  expect(
    kept.sort((a, b) => (a.hash ?? "").localeCompare(b.hash ?? "")),
  ).toEqual([
    { id: oldX, hash: "x" },
    { id: newY, hash: "y" },
    { id: oldZ, hash: "z" },
  ]);
  expect(
    await t.db.select().from(sessions).where(eq(sessions.owner, "tomtok")),
  ).toEqual([]);
  const [after] = await t.db
    .select({ sessionId: memories.sessionId })
    .from(memories)
    .where(eq(memories.id, m?.id as string));
  expect(after?.sessionId).toBe(newY);

  // Signed in with GitHub, the person's spend is what they spent before.
  const access = new Access(false, user?.id as string, new Set());
  expect(await backfillSpentMicros(t.db, access, "tomgh")).toBe(20_000);
});
