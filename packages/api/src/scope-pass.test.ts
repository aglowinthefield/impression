import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import type { Entry } from "./activity.js";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import {
  memories,
  memoryEvents,
  projects,
  sessions,
  usageEvents,
} from "./db/schema.js";
import { startDreamSchedule, SWEEP_MS } from "./dream-schedule.js";
import { logEvent } from "./events.js";
import {
  PRACTICE_SPECIFICS_RULE,
  PRACTICE_TAG,
  SYSTEM as EXTRACT_SYSTEM,
  TODO_RULE,
} from "./extract.js";
import { createMemory } from "./memories.js";
import type { CompleteRequest } from "./providers/index.js";
import {
  parseScopePass,
  SCOPE_PASS_OPERATION,
  sweepScopePass,
} from "./scope-pass.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";
import { UsageRecorder } from "./usage.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let alice: string;
let usage: UsageRecorder;
const providers = fakeProviders();
/** Every request the fake model got. */
let calls: CompleteRequest[] = [];
/** What the fake model answers, given the prompt. */
let reply: (prompt: string) => string | Promise<string>;

const SILK = "github.com/alice/silk";
const OTHER = "github.com/alice/other";
const STRANGER = "github.com/someone/private";
let silkId: string;

beforeAll(async () => {
  t = await createTestDb();
  usage = new UsageRecorder(t.db);
  const embed = providers.embeddings.embed.bind(providers.embeddings);
  providers.embeddings = {
    ...providers.embeddings,
    async embed(texts) {
      const out = await embed(texts);
      usage.record({
        kind: "embedding",
        provider: "openai",
        model: "text-embedding-3-small",
        inputTokens: 10 * texts.length,
        outputTokens: 0,
      });
      return out;
    },
  };
  providers.llm = {
    model: "claude-haiku-5-5",
    async complete(req) {
      calls.push(req);
      const out = await reply(req.prompt);
      usage.record({
        kind: "completion",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        inputTokens: 2000,
        outputTokens: 300,
      });
      return out;
    },
  };
  app = createApp(t.db, providers);
  alice = await createToken(t.db, "alice");
  const [p] = await t.db
    .insert(projects)
    .values([
      { key: SILK, name: "silk" },
      { key: OTHER, name: "other" },
      { key: STRANGER, name: "private" },
    ])
    .returning();
  silkId = p?.id as string;
});
afterAll(() => t.drop());
beforeEach(async () => {
  calls = [];
  reply = () => JSON.stringify({ results: [] });
  await t.db.delete(memoryEvents);
  await t.db.delete(memories);
  await t.db.delete(sessions);
  await t.db.delete(usageEvents);
});

/** A session alice ran in silk that also touched `touched`. */
async function session(touched: string[] = []) {
  const [s] = await t.db
    .insert(sessions)
    .values({
      projectId: silkId,
      owner: "alice",
      agent: "pi",
      transcript: "x",
      candidates: touched.map((key) => ({
        key,
        edits: 1,
        reads: 0,
        files: [],
      })),
    })
    .returning();
  return s?.id as string;
}

/** A memory stored before the release: no check mark yet. */
async function legacy(
  content: string,
  extra: Partial<typeof memories.$inferInsert> = {},
) {
  const [m] = await t.db
    .insert(memories)
    .values({
      scope: "project",
      projectId: silkId,
      owner: "alice",
      author: "alice",
      agent: "extraction",
      content,
      scopeCheckedAt: null,
      ...extra,
    })
    .returning();
  return m?.id as string;
}

const legacyPractice = (content: string, sessionId?: string) =>
  legacy(content, {
    scope: "user",
    projectId: null,
    tags: [PRACTICE_TAG],
    sessionId,
  });

const row = async (id: string) =>
  (await t.db.select().from(memories).where(eq(memories.id, id)))[0];

/** The ref the prompt gave the memory whose text contains `text`. */
function refOf(prompt: string, text: string): string {
  const blocks = prompt.split("\n\n");
  const b = blocks.find((x) => x.includes(text));
  const ref = b?.match(/^\[(m\d+)\]/)?.[1];
  if (!ref) throw new Error(`no memory with "${text}" in the prompt`);
  return ref;
}

async function call(method: string, path: string) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { authorization: `Bearer ${alice}` },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const NITPICK =
  "When running a /nitpick design session in silk, use a production-fork database on ports 3100/3101, so the design is judged on real content.";
const NITPICK_CUT =
  "When running a /nitpick design session, use a production-fork database, so the design is judged on real content.";
const NITPICK_FACT =
  "In silk, /nitpick sessions run on ports 3100/3101 since the usual ports are taken.";
const CHORE =
  "$DEV_VAULT points to a stale path ~/Documents/Dev; update it to ~/Documents/somewhere.garden in shell config.";

describe("AC4: the pass applies the extraction rules to memories stored before the release", () => {
  test("splits a practice: supersedes it with the practice without the specifics plus a fact in that repo", async () => {
    const s = await session([OTHER]);
    const id = await legacyPractice(NITPICK, s);
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            fact: NITPICK_FACT,
            project: SILK,
          },
        ],
      });
    const [r] = await sweepScopePass(t.db, providers);
    expect(r).toMatchObject({ owner: "alice", split: 1, checked: 1 });

    const old = await row(id);
    expect(old?.status).toBe("superseded");
    expect(old?.scopeCheckedAt).not.toBeNull();
    const practice = await row(old?.supersededBy as string);
    expect(practice).toMatchObject({
      scope: "user",
      projectId: null,
      content: NITPICK_CUT,
      tags: [PRACTICE_TAG],
      status: "active",
      sessionId: s,
    });
    expect(practice?.embedding).not.toBeNull();
    const facts = await t.db
      .select()
      .from(memories)
      .where(eq(memories.content, NITPICK_FACT));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      scope: "project",
      projectId: silkId,
      owner: "alice",
      tags: [],
      status: "active",
    });
  });

  test("asks with extraction's own rules and the repos the practice may name", async () => {
    const s = await session([OTHER, STRANGER]);
    await legacyPractice(NITPICK, s);
    // Alice stored a memory in OTHER, so she could reach it.
    const [other] = await t.db
      .select()
      .from(projects)
      .where(eq(projects.key, OTHER));
    await t.db.insert(memories).values({
      scope: "project",
      projectId: other?.id,
      owner: "alice",
      author: "alice",
      content: "A fact in other.",
    });
    await sweepScopePass(t.db, providers);
    expect(calls).toHaveLength(1);
    const req = calls[0] as CompleteRequest;
    // The same wording extraction uses, not a copy that could drift from it.
    expect(EXTRACT_SYSTEM).toContain(TODO_RULE);
    expect(EXTRACT_SYSTEM).toContain(PRACTICE_SPECIFICS_RULE);
    expect(req.system).toContain(TODO_RULE);
    expect(req.system).toContain(PRACTICE_SPECIFICS_RULE);
    expect(req.prompt).toContain(`${SILK} (where it was learned)`);
    expect(req.prompt).toContain(OTHER);
    // A repo alice never stored a session or memory in is not offered.
    expect(req.prompt).not.toContain(STRANGER);
  });

  test("retires a to-do, fact or practice", async () => {
    const chore = await legacy(CHORE);
    const practiceChore = await legacyPractice(
      "When the session ends, remember to clean up the stale node_modules in ~/code/old.",
    );
    const keep = await legacy("Dashboard searches send source web.");
    reply = (p) =>
      JSON.stringify({
        results: [
          { id: refOf(p, "DEV_VAULT"), action: "retire", why: "a chore" },
          { id: refOf(p, "node_modules"), action: "retire" },
          { id: refOf(p, "Dashboard"), action: "keep" },
        ],
      });
    const [r] = await sweepScopePass(t.db, providers);
    expect(r).toMatchObject({ retired: 2, kept: 1, checked: 3 });
    expect((await row(chore))?.status).toBe("retired");
    expect((await row(practiceChore))?.status).toBe("retired");
    expect(await row(keep)).toMatchObject({ status: "active" });
    expect((await row(keep))?.scopeCheckedAt).not.toBeNull();
  });

  test("a fact for a repo the person can't reach is dropped and the practice still split", async () => {
    const s = await session([STRANGER]);
    const id = await legacyPractice(NITPICK, s);
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            fact: NITPICK_FACT,
            project: STRANGER,
          },
        ],
      });
    const [r] = await sweepScopePass(t.db, providers);
    expect(r).toMatchObject({ split: 1, factsDropped: 1 });
    const old = await row(id);
    expect(old?.status).toBe("superseded");
    expect((await row(old?.supersededBy as string))?.content).toBe(NITPICK_CUT);
    const all = await t.db.select().from(memories);
    expect(all.some((m) => m.content === NITPICK_FACT)).toBe(false);
  });

  test("text the pass writes is scrubbed before it is stored", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const s = await session();
    const id = await legacyPractice(NITPICK, s);
    const chore = await legacy(CHORE);
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: `${NITPICK_CUT} Use token ${token}.`,
            fact: `${NITPICK_FACT} Token ${token}.`,
            project: SILK,
          },
          {
            id: refOf(p, "DEV_VAULT"),
            action: "retire",
            why: `chore, see ${token}`,
          },
        ],
      });
    await sweepScopePass(t.db, providers);
    const old = await row(id);
    const practice = await row(old?.supersededBy as string);
    expect(practice?.content).not.toContain(token);
    expect(practice?.content).toContain("[REDACTED:github-token]");
    const all = await t.db.select().from(memories);
    expect(all.some((m) => m.content.includes(token))).toBe(false);
    const events = await t.db.select().from(memoryEvents);
    expect(JSON.stringify(events)).not.toContain(token);
    expect((await row(chore))?.status).toBe("retired");
  });

  test("runs on the API's schedule with no step for the person", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const chore = await legacy(CHORE);
    reply = (p) =>
      JSON.stringify({
        results: [{ id: refOf(p, "DEV_VAULT"), action: "retire" }],
      });
    let ran: () => void = () => {};
    const done = new Promise<void>((r) => {
      ran = r;
    });
    const stop = startDreamSchedule(t.db, providers.dreamLlm, 20, {
      dreams: false,
      jobs: [
        async () => {
          await sweepScopePass(t.db, providers);
          ran();
        },
      ],
    });
    try {
      vi.advanceTimersByTime(SWEEP_MS);
      await done;
    } finally {
      stop();
      vi.useRealTimers();
    }
    expect((await row(chore))?.status).toBe("retired");
  });
});

describe("AC5: Activity shows the pass's changes, which can be undone", () => {
  async function passEntries() {
    const r = await call("GET", "/activity?source=pass");
    expect(r.status).toBe(200);
    return (r.json as { items: Entry[] }).items;
  }

  test("a split, its fact and a retire show with the pass as source and undo puts them back", async () => {
    const s = await session();
    const id = await legacyPractice(NITPICK, s);
    const chore = await legacy(CHORE);
    const keep = await legacy("Dashboard searches send source web.");
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            fact: NITPICK_FACT,
            project: SILK,
          },
          { id: refOf(p, "DEV_VAULT"), action: "retire", why: "a chore" },
        ],
      });
    await sweepScopePass(t.db, providers);

    const items = await passEntries();
    expect(items.map((e) => e.kind).sort()).toEqual([
      "added",
      "retired",
      "superseded",
    ]);
    for (const e of items) {
      expect(e.actor).toBe("pass");
      expect(e.canUndo).toBe(true);
    }
    // A memory the pass left alone has no entry from it at all.
    const kept = await t.db
      .select()
      .from(memoryEvents)
      .where(eq(memoryEvents.memoryId, keep));
    expect(kept).toHaveLength(0);

    const sup = items.find((e) => e.kind === "superseded") as Entry;
    expect(sup.memory?.content).toBe(NITPICK_CUT);
    expect(sup.before).toBe(NITPICK);
    const added = items.find((e) => e.kind === "added") as Entry;
    expect(added.memory?.content).toBe(NITPICK_FACT);
    const retired = items.find((e) => e.kind === "retired") as Entry;
    expect(retired.memory?.id).toBe(chore);
    expect(retired.why).toBe("a chore");

    const newPractice = sup.memory?.id as string;
    expect((await call("POST", `/activity/${sup.id}/undo`)).status).toBe(200);
    expect((await row(id))?.status).toBe("active");
    expect((await row(newPractice))?.status).toBe("retired");
    expect((await call("POST", `/activity/${added.id}/undo`)).status).toBe(200);
    expect((await row(added.memory?.id as string))?.status).toBe("retired");
    expect((await call("POST", `/activity/${retired.id}/undo`)).status).toBe(
      200,
    );
    expect((await row(chore))?.status).toBe("active");
  });

  test("a sweep that changes nothing writes no Activity entry", async () => {
    await legacy("Dashboard searches send source web.");
    await legacyPractice(NITPICK_CUT, await session());
    reply = () => JSON.stringify({ results: [] });
    const [r] = await sweepScopePass(t.db, providers);
    expect(r).toMatchObject({ kept: 2, checked: 2 });
    expect(await t.db.select().from(memoryEvents)).toHaveLength(0);
  });
});

describe("AC6: each memory is checked at most once", () => {
  test("a second start changes nothing already checked", async () => {
    const s = await session();
    await legacyPractice(NITPICK, s);
    await legacy(CHORE);
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            fact: NITPICK_FACT,
            project: SILK,
          },
          { id: refOf(p, "DEV_VAULT"), action: "retire" },
        ],
      });
    await sweepScopePass(t.db, providers);
    const before = {
      memories: await t.db
        .select()
        .from(memories)
        .orderBy(memories.id)
        .then((r) => r.map(({ embedding: _, ...m }) => m)),
      events: await t.db.select().from(memoryEvents).orderBy(memoryEvents.id),
    };
    calls = [];
    expect(await sweepScopePass(t.db, providers)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(
      await t.db
        .select()
        .from(memories)
        .orderBy(memories.id)
        .then((r) => r.map(({ embedding: _, ...m }) => m)),
    ).toEqual(before.memories);
    expect(
      await t.db.select().from(memoryEvents).orderBy(memoryEvents.id),
    ).toEqual(before.events);
  });

  test("after a crash midway, the next start checks only the memories not yet checked", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      ids.push(await legacy(`Old fact number ${n} about silk.`));
      // Distinct created_at, so batches are in insertion order.
      await t.db.execute(
        sql`UPDATE memories SET created_at = now() - ${`${10 - n} minutes`}::interval WHERE id = ${ids[n - 1]}`,
      );
    }
    let n = 0;
    reply = () => {
      n++;
      if (n === 2) throw new Error("model went away");
      return JSON.stringify({ results: [] });
    };
    await sweepScopePass(t.db, providers, { batchSize: 2 });
    const checked = async () =>
      (await t.db.select().from(memories))
        .filter((m) => m.scopeCheckedAt !== null)
        .map((m) => m.id)
        .sort();
    expect(await checked()).toEqual([ids[0], ids[1]].sort());

    calls = [];
    reply = () => JSON.stringify({ results: [] });
    await sweepScopePass(t.db, providers, { batchSize: 2 });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("number 3");
    expect(prompt).toContain("number 4");
    expect(prompt).not.toContain("number 1");
    expect(prompt).not.toContain("number 2");
    expect(await checked()).toEqual([...ids].sort());
  });

  test("a memory created after the release is never checked", async () => {
    const r = await createMemory(t.db, providers, "alice", {
      scope: "project",
      project: { key: SILK },
      content: CHORE,
      tags: [],
      dedup: false,
      anchors: [],
    });
    expect(r.status).toBe(201);
    const [raw] = await t.db
      .insert(memories)
      .values({
        scope: "project",
        projectId: silkId,
        owner: "alice",
        author: "alice",
        content: "Inserted without naming the column.",
      })
      .returning();
    expect(raw?.scopeCheckedAt).not.toBeNull();
    reply = (p) =>
      JSON.stringify({
        results: [{ id: refOf(p, "DEV_VAULT"), action: "retire" }],
      });
    expect(await sweepScopePass(t.db, providers)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect((await row((r.body as { id: string }).id))?.status).toBe("active");
  });

  test("memories the person retired, superseded or edited first are skipped", async () => {
    const retired = await legacy(`${CHORE} retired`, { status: "retired" });
    const newer = await legacy("Newer fact.");
    const superseded = await legacy(`${CHORE} superseded`, {
      status: "superseded",
      supersededBy: newer,
    });
    const edited = await legacy(`${CHORE} edited`);
    await logEvent(
      t.db,
      edited,
      "edited",
      { actor: "person", principal: "alice" },
      { before: "x", after: `${CHORE} edited` },
    );
    const [r] = await sweepScopePass(t.db, providers);
    expect(r).toMatchObject({ skipped: 1, kept: 1 });
    for (const c of calls) {
      expect(c.prompt).not.toContain("retired");
      expect(c.prompt).not.toContain("superseded");
      expect(c.prompt).not.toContain("edited");
    }
    expect((await row(retired))?.status).toBe("retired");
    expect(await row(superseded)).toMatchObject({
      status: "superseded",
      supersededBy: newer,
    });
    expect((await row(edited))?.status).toBe("active");
    expect((await row(edited))?.scopeCheckedAt).not.toBeNull();
  });

  test("a memory the person edits while its batch is with the model is left for the next batch", async () => {
    const id = await legacy(CHORE);
    reply = async (p) => {
      await t.db
        .update(memories)
        .set({ content: "Edited by alice.", updatedAt: new Date() })
        .where(eq(memories.id, id));
      await logEvent(
        t.db,
        id,
        "edited",
        { actor: "person", principal: "alice" },
        { before: CHORE, after: "Edited by alice." },
      );
      return JSON.stringify({
        results: [{ id: refOf(p, "DEV_VAULT"), action: "retire" }],
      });
    };
    await sweepScopePass(t.db, providers, { maxBatches: 1 });
    expect(await row(id)).toMatchObject({
      status: "active",
      content: "Edited by alice.",
      scopeCheckedAt: null,
    });
    calls = [];
    await sweepScopePass(t.db, providers);
    expect(calls).toHaveLength(0);
    expect((await row(id))?.status).toBe("active");
    expect((await row(id))?.scopeCheckedAt).not.toBeNull();
  });
});

describe("AC7: every model call of the pass records its operation, tokens and cost", () => {
  test("the batch call and the split's embeddings are recorded as scope-pass", async () => {
    const s = await session();
    await legacyPractice(NITPICK, s);
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            fact: NITPICK_FACT,
            project: SILK,
          },
        ],
      });
    await sweepScopePass(t.db, providers);
    await usage.flush();
    const rows = await t.db.select().from(usageEvents);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows)
      expect(r).toMatchObject({
        operation: SCOPE_PASS_OPERATION,
        principal: "alice",
      });
    const completion = rows.find((r) => r.kind === "completion");
    expect(completion).toMatchObject({
      model: "claude-haiku-5-5",
      inputTokens: 2000,
      outputTokens: 300,
    });
    expect(completion?.costMicros).toBeGreaterThan(0);
    const embedding = rows.find((r) => r.kind === "embedding");
    expect(embedding?.inputTokens).toBeGreaterThan(0);
    expect(embedding?.costMicros).not.toBeNull();
  });
});

describe("parseScopePass", () => {
  test("drops bad items and gives null for a reply without results", () => {
    expect(parseScopePass("no json")).toBeNull();
    expect(parseScopePass('{"other":[]}')).toBeNull();
    const v = parseScopePass(
      '{"results":[{"id":"m1","action":"retire"},{"id":"m2","action":"split"},{"id":"m3","action":"keep"}]}',
    );
    expect([...(v?.keys() ?? [])]).toEqual(["m1", "m3"]);
  });
});
