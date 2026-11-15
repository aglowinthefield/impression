import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { concepts, dreamRuns, memories, projects } from "./db/schema.js";
import { dueDreams, runDream, sweepDreams } from "./dream-schedule.js";
import type { LlmProvider } from "./providers/index.js";
import { createTestDb } from "./test-db.js";
import { UsageRecorder } from "./usage.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let projectId: string;
let usage: UsageRecorder;
let reply: (prompt: string) => string;

/** Puts every memory it is shown into one concept, and reports 1000 tokens each way. */
const llm: LlmProvider = {
  model: "claude-sonnet-5-5",
  async complete({ prompt }) {
    usage.record({
      kind: "completion",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    return (
      reply(prompt) ||
      JSON.stringify({
        concepts: [
          {
            ref: "n1",
            name: "All",
            summary: "s",
            memories: [...prompt.matchAll(/^(m\d+):/gm)].map((m) => m[1]),
          },
        ],
      })
    );
  },
};

beforeAll(async () => {
  t = await createTestDb();
  usage = new UsageRecorder(t.db);
  const [p] = await t.db
    .insert(projects)
    .values({ key: "github.com/acme/sched", name: "sched" })
    .returning();
  projectId = p?.id as string;
});
afterAll(() => t.drop());
beforeEach(async () => {
  reply = () => "";
  await t.db.delete(dreamRuns);
  await t.db.delete(concepts);
  await t.db.delete(memories);
});

const add = (n: number, owner = "alice", extra = {}) =>
  t.db.insert(memories).values(
    Array.from({ length: n }, (_, i) => ({
      projectId,
      scope: "project" as const,
      owner,
      author: owner,
      content: `${owner} memory ${i}`,
      ...extra,
    })),
  );

const ago = (hours: number) => sql`now() - ${`${hours} hours`}::interval`;

/** A finished run that started `hours` ago. */
const ran = (hours: number, error: string | null = null, owner = "alice") =>
  t.db.insert(dreamRuns).values({
    projectId,
    owner,
    trigger: "daily",
    model: "x",
    startedAt: ago(hours),
    finishedAt: ago(hours),
    error,
  });

const due = async (every = 20) =>
  (await dueDreams(t.db, every)).map((d) => [d.owner, d.trigger]);

test("a person needs enough memories before a first run", async () => {
  await add(7);
  expect(await due()).toEqual([]);
  await add(1);
  expect(await due()).toEqual([["alice", "daily"]]);
});

test("enough changes since the last run make it due now, fewer wait a day", async () => {
  await add(10);
  await t.db.update(memories).set({ updatedAt: ago(3) });
  await ran(2);
  expect(await due()).toEqual([]);
  await add(5);
  expect(await due(6)).toEqual([]);
  await add(1);
  expect(await due(6)).toEqual([["alice", "count"]]);
  await t.db.update(dreamRuns).set({ startedAt: ago(25) });
  expect(await due()).toEqual([["alice", "daily"]]);
});

test("nothing changed means no run, however old the last one", async () => {
  await add(10);
  await t.db.update(memories).set({ updatedAt: ago(50) });
  await ran(48);
  expect(await due()).toEqual([]);
  // A retired memory is a change.
  await t.db
    .update(memories)
    .set({ status: "retired", updatedAt: sql`now()` })
    .where(eq(memories.content, "alice memory 0"));
  expect(await due()).toEqual([["alice", "daily"]]);
});

test("a failed run holds off retries for an hour but doesn't count as done", async () => {
  await add(10);
  await ran(0.5, "boom");
  expect(await due()).toEqual([]);
  await t.db.update(dreamRuns).set({ startedAt: ago(2) });
  expect(await due()).toEqual([["alice", "daily"]]);
});

test("practices don't count, and team memories count for everyone", async () => {
  await add(10, "alice", { tags: ["practice"] });
  await add(1, "bob");
  expect(await due()).toEqual([]);
  await add(8, "carol", { scope: "team" });
  expect((await due()).sort()).toEqual([
    ["alice", "daily"],
    ["bob", "daily"],
    ["carol", "daily"],
  ]);
});

test("runDream records what it did and what it cost", async () => {
  await add(3);
  const r = await runDream(t.db, llm, projectId, "alice", "manual");
  expect(r).toMatchObject({ memories: 3, concepts: 1, uncategorized: 0 });
  const [row] = await t.db.select().from(dreamRuns);
  expect(row).toMatchObject({
    trigger: "manual",
    model: "claude-sonnet-5-5",
    memories: 3,
    concepts: 1,
    created: 1,
    error: null,
    // 1000 tokens each way at $2 and $10 per million.
    costMicros: 12_000,
  });
  expect(row?.finishedAt).toBeInstanceOf(Date);
});

test("a failed run is recorded with its error", async () => {
  await add(3);
  reply = () => "not json";
  await expect(
    runDream(t.db, llm, projectId, "alice", "count"),
  ).rejects.toThrow();
  const [row] = await t.db.select().from(dreamRuns);
  expect(row?.error).toBeTruthy();
  expect(row?.finishedAt).toBeInstanceOf(Date);
});

test("a sweep runs what's due and keeps going past a failure", async () => {
  await add(8, "alice");
  await add(8, "bob");
  let calls = 0;
  reply = () => (calls++ === 0 ? "not json" : "");
  expect(await sweepDreams(t.db, llm)).toBe(1);
  const runs = await t.db.select().from(dreamRuns);
  expect(runs.map((r) => r.error === null).sort()).toEqual([false, true]);
  // Both just ran, so nothing is due.
  expect(await due()).toEqual([]);
});

test("retiring a memory regroups its owner and removes a concept left empty", async () => {
  await add(9);
  reply = (p) => {
    const refs = [...p.matchAll(/^(m\d+): (.*)$/gm)];
    const lonely = refs.filter(
      (m) => m[2]?.replace(/ \[.*$/, "") === "alice memory 0",
    );
    const rest = refs.filter((m) => !lonely.includes(m));
    return JSON.stringify({
      concepts: [
        {
          ref: "n1",
          name: "Lonely",
          summary: "s",
          memories: lonely.map((m) => m[1]),
        },
        {
          ref: "n2",
          name: "Rest",
          summary: "s",
          memories: rest.map((m) => m[1]),
        },
      ],
    });
  };
  await runDream(t.db, llm, projectId, "alice", "manual");
  const names = async () =>
    (await t.db.select().from(concepts)).map((c) => c.name).sort();
  expect(await names()).toEqual(["Lonely", "Rest"]);

  // A day later the recheck retires the only member of Lonely.
  await t.db.update(memories).set({ updatedAt: ago(26) });
  await t.db
    .update(memories)
    .set({ status: "retired", updatedAt: sql`now()` })
    .where(eq(memories.content, "alice memory 0"));
  await t.db.update(dreamRuns).set({ startedAt: ago(25), finishedAt: ago(25) });
  expect(await due()).toEqual([["alice", "daily"]]);

  reply = () => "";
  expect(await sweepDreams(t.db, llm)).toBe(1);
  expect(await names()).not.toContain("Lonely");
  expect(await names()).toHaveLength(1);
});
