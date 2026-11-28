import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
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
  users,
} from "./db/schema.js";
import { logEvent } from "./events.js";
import {
  PRACTICE_SPECIFICS_RULE,
  PRACTICE_TAG,
  SYSTEM as EXTRACT_SYSTEM,
  TODO_RULE,
} from "./extract.js";
import type { CompleteRequest } from "./providers/index.js";
import {
  parseScopePass,
  type RepoSource,
  runScopePass,
  SCOPE_PASS_MAX_ATTEMPTS,
  SCOPE_PASS_OPERATION,
  type ScopePassOptions,
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
let strangerId: string;

/** gina signs in with GitHub, so she reaches only the repos GitHub lists for her now. */
let ginaRepos: Set<string> | Error;
const repos: RepoSource = {
  async reposFor() {
    if (ginaRepos instanceof Error) throw ginaRepos;
    return ginaRepos;
  },
};

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
      const out = onlyThisBatch(await reply(req.prompt));
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
  strangerId = (
    await t.db.select().from(projects).where(eq(projects.key, STRANGER))
  )[0]?.id as string;
  const [gina] = await t.db
    .insert(users)
    .values({ githubId: 4242, login: "gina" })
    .returning();
  await createToken(t.db, "gina", { userId: gina?.id });
  await createToken(t.db, "bob");
});
afterAll(() => t.drop());
beforeEach(async () => {
  calls = [];
  ginaRepos = new Set([SILK]);
  reply = () => JSON.stringify({ results: [] });
  await t.db.delete(memoryEvents);
  await t.db.delete(memories);
  await t.db.delete(sessions);
  await t.db.delete(usageEvents);
});

/** A session alice (or `owner`) ran in silk that also touched `touched`. */
async function session(touched: string[] = [], owner = "alice") {
  const [s] = await t.db
    .insert(sessions)
    .values({
      projectId: silkId,
      owner,
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

/** Runs the pass with a cutoff of now, as the script does by default. */
const pass = (opts: Partial<ScopePassOptions> = {}) =>
  runScopePass(t.db, providers, { before: new Date(), ...opts });

/** A memory stored before the release. */
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
      // Stored well before the pass starts, so the default cutoff (now) never ties with it.
      createdAt: new Date(Date.now() - 60 * 60_000),
      ...extra,
    })
    .returning();
  return m?.id as string;
}

const legacyPractice = (content: string, sessionId?: string, owner = "alice") =>
  legacy(content, {
    scope: "user",
    projectId: null,
    tags: [PRACTICE_TAG],
    sessionId,
    owner,
    author: owner,
  });

const row = async (id: string) =>
  (await t.db.select().from(memories).where(eq(memories.id, id)))[0];

/** The ref the prompt gave the memory whose text contains `text`. */
/** The ref of the memory holding `text` in this prompt, or "" when it's in another batch. */
function refOf(prompt: string, text: string): string {
  const blocks = prompt.split("\n\n");
  const b = blocks.find((x) => x.includes(text));
  return b?.match(/^\[(m\d+)\]/)?.[1] ?? "";
}

/** Drops the verdicts a reply gives for memories that sit in another batch. */
function onlyThisBatch(out: string): string {
  try {
    const r = JSON.parse(out) as { results?: { id?: string }[] };
    if (!Array.isArray(r.results)) return out;
    return JSON.stringify({
      ...r,
      results: r.results.filter((x) => x.id !== ""),
    });
  } catch {
    return out;
  }
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
    const r = await pass();
    expect(r.changes).toEqual([
      {
        memoryId: id,
        owner: "alice",
        old: NITPICK,
        action: "split",
        practice: NITPICK_CUT,
        fact: { project: SILK, text: NITPICK_FACT },
      },
    ]);

    const old = await row(id);
    expect(old?.status).toBe("superseded");
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
    ginaRepos = new Set([SILK, OTHER]);
    const s = await session([OTHER, STRANGER], "gina");
    await legacyPractice(NITPICK, s, "gina");
    await pass({ repos });
    expect(calls).toHaveLength(1);
    const req = calls[0] as CompleteRequest;
    // The same wording extraction uses, not a copy that could drift from it.
    expect(EXTRACT_SYSTEM).toContain(TODO_RULE);
    expect(EXTRACT_SYSTEM).toContain(PRACTICE_SPECIFICS_RULE);
    expect(req.system).toContain(TODO_RULE);
    expect(req.system).toContain(PRACTICE_SPECIFICS_RULE);
    expect(req.prompt).toContain(`${SILK} (where it was learned)`);
    expect(req.prompt).toContain(OTHER);
    // A repo gina can't access now is not offered.
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
    const r = await pass();
    expect(r.changes.map((c) => c.action)).toEqual(["retire", "retire"]);
    expect(r.kept).toBe(1);
    expect((await row(chore))?.status).toBe("retired");
    expect((await row(practiceChore))?.status).toBe("retired");
    expect(await row(keep)).toMatchObject({ status: "active" });
  });

  test("a fact for a repo the person can't reach is dropped and the practice still split", async () => {
    const s = await session([STRANGER], "gina");
    const id = await legacyPractice(NITPICK, s, "gina");
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
    const r = await pass({ repos });
    expect(r.changes).toMatchObject([{ action: "split", fact: null }]);
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
    await pass();
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
});

describe("AC4: the pass acts only where the person has access now", () => {
  const split = (project: string) => (p: string) =>
    JSON.stringify({
      results: [
        {
          id: refOf(p, "/nitpick"),
          action: "split",
          practice: NITPICK_CUT,
          fact: NITPICK_FACT,
          project,
        },
      ],
    });
  const factStored = async () =>
    (await t.db.select().from(memories)).some(
      (m) => m.content === NITPICK_FACT,
    );

  test("a repo the person once stored in but can't access now gets no fact", async () => {
    // gina stored a memory in OTHER before, but GitHub no longer lists it for her.
    const [other] = await t.db
      .select()
      .from(projects)
      .where(eq(projects.key, OTHER));
    await t.db.insert(memories).values({
      scope: "project",
      projectId: other?.id,
      owner: "gina",
      author: "gina",
      content: "A fact in other.",
    });
    const s = await session([OTHER], "gina");
    const id = await legacyPractice(NITPICK, s, "gina");
    reply = split(OTHER);
    const r = await pass({ repos });
    expect(calls[0]?.prompt).not.toContain(OTHER);
    expect(r.changes).toMatchObject([{ action: "split", fact: null }]);
    expect((await row(id))?.status).toBe("superseded");
    expect(await factStored()).toBe(false);
  });

  test("when current access can't be read, the fact is dropped and the practice still split", async () => {
    ginaRepos = new Error("GitHub is down");
    const s = await session([], "gina");
    const id = await legacyPractice(NITPICK, s, "gina");
    reply = split(SILK);
    const r = await pass({ repos });
    expect(calls[0]?.prompt).not.toContain(SILK);
    expect(r.changes).toMatchObject([{ action: "split", fact: null }]);
    const old = await row(id);
    expect(old?.status).toBe("superseded");
    expect((await row(old?.supersededBy as string))?.content).toBe(NITPICK_CUT);
    expect(await factStored()).toBe(false);
  });

  test("memories in a project the owner can't access now are neither read nor changed", async () => {
    const hidden = await legacy(`${CHORE} private`, {
      projectId: strangerId,
      owner: "gina",
      author: "gina",
    });
    const seen = await legacy(CHORE, { owner: "gina", author: "gina" });
    reply = (p) =>
      JSON.stringify({
        results: [{ id: refOf(p, "DEV_VAULT"), action: "retire" }],
      });
    await pass({ repos });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).not.toContain("private");
    expect((await row(seen))?.status).toBe("retired");
    expect(await row(hidden)).toMatchObject({ status: "active" });
  });

  test("when current access can't be read, only memories outside any project are checked", async () => {
    ginaRepos = new Error("GitHub session expired");
    const inSilk = await legacy(`${CHORE} silk`, {
      owner: "gina",
      author: "gina",
    });
    const mine = await legacy(CHORE, {
      scope: "user",
      projectId: null,
      owner: "gina",
      author: "gina",
    });
    reply = (p) =>
      JSON.stringify({
        results: [{ id: refOf(p, "DEV_VAULT"), action: "retire" }],
      });
    await pass({ repos });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).not.toContain("silk");
    expect((await row(mine))?.status).toBe("retired");
    expect(await row(inSilk)).toMatchObject({ status: "active" });
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
    await pass();

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
    // Stored as extraction's events, but never listed as extraction's.
    const extraction = await call("GET", "/activity?source=extraction");
    expect((extraction.json as { items: Entry[] }).items).toEqual([]);
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

  test("undoing an earlier merge never rewrites the practice the pass superseded", async () => {
    const s = await session();
    const id = await legacyPractice(NITPICK, s);
    const merged = await logEvent(
      t.db,
      id,
      "merged",
      { actor: "extraction", principal: "alice" },
      { before: "Older practice text.", after: NITPICK },
    );
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            project: SILK,
          },
        ],
      });
    await pass();
    expect((await row(id))?.status).toBe("superseded");

    expect((await call("POST", `/activity/${merged}/undo`)).status).toBe(409);
    expect(await row(id)).toMatchObject({
      status: "superseded",
      content: NITPICK,
    });
  });

  test("a run that changes nothing writes no Activity entry", async () => {
    await legacy("Dashboard searches send source web.");
    await legacyPractice(NITPICK_CUT, await session());
    reply = () => JSON.stringify({ results: [] });
    const r = await pass();
    expect(r).toMatchObject({ kept: 2, changes: [] });
    expect(await t.db.select().from(memoryEvents)).toHaveLength(0);
  });
});

describe("AC6: one owner and visibility per call, and nothing done twice", () => {
  test("one model call holds one owner's memories of one scope and project", async () => {
    const [other] = await t.db
      .select()
      .from(projects)
      .where(eq(projects.key, OTHER));
    await legacyPractice(NITPICK, await session());
    await legacy("Private fact in silk.");
    await legacy("Team fact in silk.", { scope: "team" });
    await legacy("Team fact in other.", {
      scope: "team",
      projectId: other?.id,
    });
    await legacy("Bob's own fact.", {
      scope: "user",
      projectId: null,
      owner: "bob",
      author: "bob",
    });
    await pass();
    const prompts = calls.map((c) => c.prompt);
    expect(prompts).toHaveLength(5);
    const holding = (text: string) => prompts.filter((p) => p.includes(text));
    // A user-scoped practice never shares a call with a repo's private text.
    expect(holding("/nitpick")).toHaveLength(1);
    expect(holding("/nitpick")[0]).not.toContain("Private fact in silk.");
    expect(holding("Team fact in silk.")).toHaveLength(1);
    expect(holding("Team fact in silk.")[0]).not.toContain("fact in other");
    expect(holding("Team fact in silk.")[0]).not.toContain("Private");
    expect(holding("Team fact in other.")[0]).not.toContain("Private");
    expect(holding("Bob's own fact.")[0]).not.toContain("silk");
  });

  test("an owner's memories go in small batches, each read once", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      ids.push(await legacy(`Old fact number ${n} about silk.`));
      await t.db.execute(
        sql`UPDATE memories SET created_at = now() - ${`${10 - n} minutes`}::interval WHERE id = ${ids[n - 1]}`,
      );
    }
    const r = await pass({ batchSize: 2 });
    expect(r.kept).toBe(5);
    expect(
      calls.map((c) => (c.prompt.match(/number \d/g) ?? []).join()),
    ).toEqual(["number 1,number 2", "number 3,number 4", "number 5"]);
  });

  test("a second run with the same cutoff changes nothing", async () => {
    const before = new Date();
    const s = await session();
    await legacyPractice(NITPICK, s, "alice");
    await legacy(CHORE);
    await t.db.execute(
      sql`UPDATE memories SET created_at = ${before.toISOString()}::timestamptz - interval '1 minute'`,
    );
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
    expect((await pass({ before })).changes).toHaveLength(2);
    const snapshot = async () => ({
      memories: await t.db
        .select()
        .from(memories)
        .orderBy(memories.id)
        .then((r) => r.map(({ embedding: _, ...m }) => m)),
      events: await t.db.select().from(memoryEvents).orderBy(memoryEvents.id),
    });
    const first = await snapshot();
    expect(first.memories).toHaveLength(4);

    calls = [];
    // Whatever the model would say, the second run reads nothing the first changed or created.
    reply = (p) =>
      JSON.stringify({
        results: [...p.matchAll(/^\[(m\d+)\]/gm)].map((m) => ({
          id: m[1],
          action: "retire",
        })),
      });
    const again = await pass({ before });
    expect(again).toEqual({ changes: [], kept: 0, skipped: [] });
    expect(calls).toHaveLength(0);
    expect(await snapshot()).toEqual(first);
  });

  test("memories created after the cutoff are never read", async () => {
    const old = await legacy(`${CHORE} old`);
    await t.db.execute(
      sql`UPDATE memories SET created_at = now() - interval '1 hour' WHERE id = ${old}`,
    );
    const cutoff = new Date(Date.now() - 30 * 60_000);
    const fresh = await legacy(`${CHORE} fresh`, { createdAt: new Date() });
    reply = (p) =>
      JSON.stringify({
        results: [...p.matchAll(/^\[(m\d+)\]/gm)].map((m) => ({
          id: m[1],
          action: "retire",
        })),
      });
    await pass({ before: cutoff });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).not.toContain("fresh");
    expect((await row(old))?.status).toBe("retired");
    expect((await row(fresh))?.status).toBe("active");
  });

  test("retired and superseded memories are not read", async () => {
    await legacy(`${CHORE} retired`, { status: "retired" });
    const newer = await legacy("Newer fact.");
    await legacy(`${CHORE} superseded`, {
      status: "superseded",
      supersededBy: newer,
    });
    await pass();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).not.toContain("retired");
    expect(calls[0]?.prompt).not.toContain("superseded");
  });

  test("a memory edited while its batch is with the model is left alone", async () => {
    const chore = await legacy(CHORE);
    const practice = await legacyPractice(NITPICK, await session());
    // Each call moves both rows to a new, distinct time, whatever the clock does.
    let bump = 0;
    reply = async (p) => {
      bump++;
      for (const id of [chore, practice])
        await t.db
          .update(memories)
          .set({ updatedAt: new Date(Date.UTC(2030, 0, 1) + bump * 1000) })
          .where(eq(memories.id, id));
      return JSON.stringify({
        results: [
          { id: refOf(p, "DEV_VAULT"), action: "retire" },
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            fact: NITPICK_FACT,
            project: SILK,
          },
        ],
      });
    };
    const r = await pass();
    expect(r.changes).toEqual([]);
    // They sit in separate batches, so the order of the two doesn't matter.
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { memoryId: chore, owner: "alice", why: "changed" },
        { memoryId: practice, owner: "alice", why: "changed" },
      ]),
    );
    expect((await row(chore))?.status).toBe("active");
    expect((await row(practice))?.status).toBe("active");
    expect(await t.db.select().from(memories)).toHaveLength(2);
    expect(await t.db.select().from(memoryEvents)).toHaveLength(0);
  });
});

describe("--dry-run writes nothing and reports each proposed change", () => {
  test("proposes the split, the fact's repo and the retire without changing anything", async () => {
    const NEW = "github.com/alice/brand-new";
    const practice = await legacyPractice(NITPICK, await session([NEW]));
    const chore = await legacy(CHORE);
    reply = (p) =>
      JSON.stringify({
        results: [
          {
            id: refOf(p, "/nitpick"),
            action: "split",
            practice: NITPICK_CUT,
            fact: NITPICK_FACT,
            project: NEW,
          },
          { id: refOf(p, "DEV_VAULT"), action: "retire", why: "a chore" },
        ],
      });
    const state = async () => ({
      memories: await t.db.select().from(memories).orderBy(memories.id),
      events: await t.db.select().from(memoryEvents),
      projects: await t.db.select().from(projects).orderBy(projects.id),
    });
    const before = await state();
    const seen: unknown[] = [];
    const r = await pass({ dryRun: true, onChange: (c) => seen.push(c) });
    expect(r.changes).toEqual([
      {
        memoryId: practice,
        owner: "alice",
        old: NITPICK,
        action: "split",
        practice: NITPICK_CUT,
        fact: { project: NEW, text: NITPICK_FACT },
      },
      {
        memoryId: chore,
        owner: "alice",
        old: CHORE,
        action: "retire",
        why: "a chore",
      },
    ]);
    expect(seen).toEqual(r.changes);
    expect(await state()).toEqual(before);
  });
});

describe("a reply the pass can't read is retried, then the batch is given up", () => {
  test(`after ${SCOPE_PASS_MAX_ATTEMPTS} unreadable replies its memories are skipped and named`, async () => {
    const id = await legacy(CHORE);
    reply = () => "sorry, I can't help with that";
    const r = await pass();
    expect(calls).toHaveLength(SCOPE_PASS_MAX_ATTEMPTS);
    expect(r.skipped).toEqual([
      { memoryId: id, owner: "alice", why: "unreadable" },
    ]);
    expect((await row(id))?.status).toBe("active");
    expect(await t.db.select().from(memoryEvents)).toHaveLength(0);
  });

  test("a readable reply within the attempts is used", async () => {
    const id = await legacy(CHORE);
    let n = 0;
    reply = (p) => {
      n++;
      if (n === 1) return "not json";
      if (n === 2) throw new Error("model went away");
      return JSON.stringify({
        results: [{ id: refOf(p, "DEV_VAULT"), action: "retire" }],
      });
    };
    const r = await pass();
    expect(calls).toHaveLength(3);
    expect(r.skipped).toEqual([]);
    expect((await row(id))?.status).toBe("retired");
  });

  test("one owner's failing batch doesn't hold up anyone else's", async () => {
    const stuck = await legacy(`${CHORE} alice`);
    const bobs = await legacy(`${CHORE} bob`, {
      scope: "user",
      projectId: null,
      owner: "bob",
      author: "bob",
    });
    reply = (p) =>
      p.includes("alice")
        ? "not json"
        : JSON.stringify({
            results: [{ id: refOf(p, "DEV_VAULT"), action: "retire" }],
          });
    const r = await pass();
    expect(calls).toHaveLength(SCOPE_PASS_MAX_ATTEMPTS + 1);
    expect((await row(bobs))?.status).toBe("retired");
    expect((await row(stuck))?.status).toBe("active");
    expect(r.skipped.map((s) => s.memoryId)).toEqual([stuck]);
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
    await pass();
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
