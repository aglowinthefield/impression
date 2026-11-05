import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { memories } from "./db/schema.js";
import { reembed } from "./reembed.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.drop());

test("embeds only rows that have no vector", async () => {
  const [a, b] = await t.db
    .insert(memories)
    .values([
      { scope: "user", owner: "o", author: "o", content: "use pnpm" },
      {
        scope: "user",
        owner: "o",
        author: "o",
        content: "run migrations first",
      },
    ])
    .returning();
  const p = fakeProviders();
  expect(await reembed(t.db, p)).toEqual({ memories: 2, proposals: 0 });
  expect(
    await t.db.select().from(memories).where(isNull(memories.embedding)),
  ).toEqual([]);
  const [row] = await t.db
    .select()
    .from(memories)
    .where(eq(memories.id, (a as { id: string }).id));
  expect(row?.embeddingModel).toBe("fake-bow");
  p.embedCalls.length = 0;
  expect(await reembed(t.db, p)).toEqual({ memories: 0, proposals: 0 });
  expect(p.embedCalls).toEqual([]);
  expect(b).toBeDefined();
});
