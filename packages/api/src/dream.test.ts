import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import {
  conceptLinks,
  conceptMemories,
  concepts,
  usageEvents,
} from "./db/schema.js";
import {
  buildDreamPrompt,
  type DreamPlan,
  type ExistingConcept,
  parseDream,
  resolvePlan,
} from "./dream.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";
import { UsageRecorder } from "./usage.js";

describe("parseDream", () => {
  test("reads the JSON object out of a reply", () => {
    const plan = parseDream(
      'Here:\n{"concepts":[{"ref":"n1","parent":"","name":"Auth","summary":"s","memories":["m1"]}]}',
    );
    expect(plan).toEqual({
      concepts: [
        {
          ref: "n1",
          parent: null,
          name: "Auth",
          summary: "s",
          memories: ["m1"],
        },
      ],
      links: [],
    });
  });

  test("rejects replies that aren't a plan", () => {
    expect(parseDream("no idea")).toBeNull();
    expect(parseDream('{"concepts":"x"}')).toBeNull();
    expect(parseDream("{not json}")).toBeNull();
  });
});

describe("resolvePlan", () => {
  const refs = new Map([
    ["m1", "id1"],
    ["m2", "id2"],
    ["m3", "id3"],
    ["m4", "id4"],
  ]);
  const c = (
    ref: string,
    memories: string[],
    parent: string | null = null,
    name = ref,
  ) => ({ ref, parent, name, summary: "", memories });

  test("drops unknown memories, empty concepts and links to dropped concepts", () => {
    const r = resolvePlan(
      {
        concepts: [c("n1", ["m1", "m9", "m1"]), c("n2", ["m9"])],
        links: [
          ["n1", "n2"],
          ["n1", "n1"],
        ],
      },
      refs,
      [],
    );
    expect(r.concepts.map((x) => [x.ref, x.memoryIds])).toEqual([
      ["n1", ["id1"]],
    ]);
    expect(r.links).toEqual([]);
  });

  test("keeps nesting to one level and keeps areas whose subtopics have members", () => {
    const r = resolvePlan(
      {
        concepts: [
          c("area", []),
          c("sub", ["m1"], "area"),
          c("subsub", ["m2"], "sub"),
          c("orphan", ["m3"], "missing"),
        ],
        links: [["subsub", "orphan"]],
      },
      refs,
      [],
    );
    const parents = Object.fromEntries(
      r.concepts.map((x) => [x.ref, x.parentRef]),
    );
    expect(parents).toEqual({
      area: null,
      sub: "area",
      subsub: null,
      orphan: null,
    });
    expect(r.links).toEqual([["orphan", "subsub"]]);
  });

  test("matches existing concepts by members, not by the ref the model gave", () => {
    const existing: ExistingConcept[] = [
      {
        id: "old-a",
        parentId: null,
        name: "Auth",
        summary: "",
        memoryIds: ["id1", "id2"],
      },
      {
        id: "old-b",
        parentId: null,
        name: "Hooks",
        summary: "",
        memoryIds: ["id3", "id4"],
      },
    ];
    const plan: DreamPlan = {
      concepts: [
        // Swapped refs and a new name: membership wins and the old name stays.
        c("c2", ["m1", "m2"], null, "Authentication"),
        c("c1", ["m3"], null, "Hook failures"),
        c("n1", ["m4"], null, "Something else"),
      ],
      links: [],
    };
    const r = resolvePlan(plan, refs, existing);
    expect(r.concepts.map((x) => [x.id, x.name])).toEqual([
      ["old-a", "Auth"],
      ["old-b", "Hook failures"],
      [null, "Something else"],
    ]);
  });
});

test("buildDreamPrompt numbers memories and lists last run's concepts", () => {
  const { prompt, memoryRefs } = buildDreamPrompt(
    [
      {
        id: "a",
        content: "Tokens live in\nthe keychain",
        tags: [],
        paths: ["src/auth.ts"],
      },
      { id: "b", content: "x".repeat(700), tags: ["api"], paths: [] },
    ],
    [
      {
        id: "k",
        parentId: null,
        name: "Auth",
        summary: "How auth works",
        memoryIds: ["a", "gone"],
      },
    ],
  );
  expect([...memoryRefs]).toEqual([
    ["m1", "a"],
    ["m2", "b"],
  ]);
  expect(prompt).toContain(
    "m1: Tokens live in the keychain [files: src/auth.ts]",
  );
  expect(prompt).toContain(`m2: ${"x".repeat(600)}… [tags: api]`);
  expect(prompt).toContain(
    "c1: Auth\n  summary: How auth works\n  memories: m1",
  );
});

describe("POST /api/dream", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createApp>;
  let alice: string;
  let bob: string;
  let usage: UsageRecorder;
  let reply: (prompt: string) => string = () => "";
  const prompts: string[] = [];
  const project = { key: "github.com/acme/dream" };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb();
    usage = new UsageRecorder(t.db);
    const providers = fakeProviders();
    providers.llm = {
      model: "fake",
      async complete(req) {
        prompts.push(req.prompt);
        usage.record({
          kind: "completion",
          provider: "anthropic",
          model: "fake",
          inputTokens: 1,
          outputTokens: 1,
        });
        return reply(req.prompt);
      },
    };
    app = createApp(t.db, providers);
    alice = await createToken(t.db, "alice");
    bob = await createToken(t.db, "bob");
    const add = async (
      token: string,
      key: string,
      content: string,
      extra: Record<string, unknown> = {},
    ) => {
      const res = await app.request("/api/memories", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scope: "project",
          project,
          content,
          dedup: false,
          ...extra,
        }),
      });
      expect(res.status).toBe(201);
      ids[key] = (await res.json()).id;
    };
    await add(alice, "login", "Login goes through GitHub's device flow");
    await add(alice, "tokens", "API tokens are hashed with sha256");
    await add(alice, "hooks", "The session-end hook uploads the transcript");
    await add(alice, "practice", "Prefer small commits", {
      scope: "user",
      project: undefined,
      tags: ["practice"],
    });
    await add(bob, "bobs", "Bob's private note about deploys");
    await add(bob, "team", "Deploys go through Fly");
    const shared = await app.request(`/api/memories/${ids.team}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${bob}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scope: "team" }),
    });
    expect(shared.status).toBe(200);
  });
  afterAll(() => t.drop());
  beforeEach(() => {
    prompts.length = 0;
  });

  const dreamCall = (token = alice, key = project.key) =>
    app.request(`/api/dream?project=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

  /** The memory ref the prompt gave a memory, found by a word of its text. */
  const ref = (prompt: string, word: string) =>
    prompt.match(new RegExp(`(m\\d+): [^\\n]*${word}`))?.[1] as string;

  const conceptsOf = async (owner: string) => {
    const rows = await t.db
      .select()
      .from(concepts)
      .where(eq(concepts.owner, owner))
      .orderBy(concepts.name);
    const members = await t.db.select().from(conceptMemories);
    return rows.map((r) => ({
      ...r,
      members: members
        .filter((m) => m.conceptId === r.id)
        .map((m) => m.memoryId)
        .sort(),
    }));
  };

  test("groups the caller's memories and team ones, without practices or others' private ones", async () => {
    reply = (p) =>
      JSON.stringify({
        concepts: [
          {
            ref: "n1",
            parent: null,
            name: "Auth",
            summary: "How sign-in works",
            memories: [ref(p, "Login"), ref(p, "tokens")],
          },
          {
            ref: "n2",
            parent: null,
            name: "Hooks and deploys",
            summary: "s",
            memories: [ref(p, "hook"), ref(p, "Fly")],
          },
        ],
        links: [["n1", "n2"]],
      });
    const res = await dreamCall();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      memories: 4,
      concepts: 2,
      created: 2,
      kept: 0,
      removed: 0,
      uncategorized: 0,
    });
    expect(prompts[0]).toContain("Fly");
    expect(prompts[0]).not.toContain("small commits");
    expect(prompts[0]).not.toContain("private note");
    const cs = await conceptsOf("alice");
    expect(cs.map((c) => [c.name, c.members])).toEqual([
      ["Auth", [ids.login, ids.tokens].sort()],
      ["Hooks and deploys", [ids.hooks, ids.team].sort()],
    ]);
    expect(await t.db.select().from(conceptLinks)).toHaveLength(1);
    await usage.flush();
    const used = await t.db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.operation, "dream"));
    expect(used).toHaveLength(1);
  });

  test("a rerun keeps ids of concepts whose members barely changed and removes the rest", async () => {
    const before = await conceptsOf("alice");
    reply = (p) => {
      expect(p).toMatch(/c\d: Auth\n/);
      return JSON.stringify({
        concepts: [
          {
            ref: "c1",
            parent: null,
            name: "Signing in",
            summary: "How sign-in works now",
            memories: [ref(p, "Login"), ref(p, "tokens")],
          },
        ],
        links: [],
      });
    };
    const res = await dreamCall();
    expect(await res.json()).toMatchObject({
      concepts: 1,
      created: 0,
      kept: 1,
      removed: 1,
      uncategorized: 2,
    });
    const after = await conceptsOf("alice");
    const auth = after.find((c) => c.id === before[0]?.id);
    expect(auth).toMatchObject({
      name: "Auth",
      summary: "How sign-in works now",
    });
    expect(after).toHaveLength(1);
    expect(await t.db.select().from(conceptLinks)).toHaveLength(0);
  });

  test("bob's run leaves alice's concepts alone", async () => {
    reply = (p) =>
      JSON.stringify({
        concepts: [
          {
            ref: "n1",
            name: "Deploys",
            summary: "s",
            memories: [ref(p, "Fly"), ref(p, "deploys")],
          },
        ],
      });
    expect((await dreamCall(bob)).status).toBe(200);
    expect(await conceptsOf("alice")).toHaveLength(1);
    expect(await conceptsOf("bob")).toHaveLength(1);
  });

  test("a reply that isn't a plan changes nothing", async () => {
    const before = await conceptsOf("alice");
    reply = () => "sorry";
    const res = await dreamCall();
    expect(res.status).toBe(502);
    expect(await conceptsOf("alice")).toEqual(before);
  });

  test("needs a visible project", async () => {
    expect((await dreamCall(alice, "")).status).toBe(400);
    expect((await dreamCall(alice, "github.com/acme/nope")).status).toBe(404);
  });
});
