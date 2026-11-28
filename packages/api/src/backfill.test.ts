import { pieceHash } from "@impression/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { estimateMicros } from "./backfill.js";
import {
  memories,
  memoryEvents,
  projects,
  sessions,
  usageEvents,
  users,
} from "./db/schema.js";
import { SYSTEM } from "./extract.js";
import type { CompleteRequest, LlmProvider } from "./providers/index.js";
import type { RepoAccess } from "./repo-access.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";
import { UsageRecorder } from "./usage.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A model the test drives: each call records Sonnet usage of 10,000 input and
 * 1,000 output tokens ($0.03), answers with one memory, and can be held open
 * until the test lets it finish.
 */
class FakeModel implements LlmProvider {
  readonly provider = "anthropic" as const;
  prompts: string[] = [];
  /** The memory text for the next reply; a fresh one per call by default. */
  next: string | null = null;
  fail = false;
  private held: {
    started: ReturnType<typeof deferred>;
    gate: ReturnType<typeof deferred>;
  } | null = null;

  constructor(
    readonly model: string,
    private usage: UsageRecorder,
  ) {}

  /** Holds the next call open. Await `started`, then call `release`. */
  hold() {
    const h = { started: deferred(), gate: deferred() };
    this.held = h;
    return { started: h.started.promise, release: h.gate.resolve };
  }

  async complete(req: CompleteRequest) {
    this.prompts.push(req.prompt);
    const held = this.held;
    this.held = null;
    if (held) {
      held.started.resolve();
      await held.gate.promise;
    }
    if (this.fail) {
      this.fail = false;
      throw new Error("model down");
    }
    void this.usage.record({
      kind: "completion",
      provider: "anthropic",
      model: this.model,
      inputTokens: 10_000,
      outputTokens: 1_000,
    });
    const content =
      this.next ?? `Fact ${this.prompts.length} zz${this.prompts.length}`;
    this.next = null;
    return JSON.stringify({
      memories: [{ kind: "fact", content, confidence: 0.9, anchors: [] }],
    });
  }
}

let t: Awaited<ReturnType<typeof createTestDb>>;
let usage: UsageRecorder;
let model: FakeModel;
let live: FakeModel;
let app: ReturnType<typeof createApp>;
let tight: ReturnType<typeof createApp>;
/** The live model's answer to the dedup check. */
let verdict = (_prompt: string) => '{"action":"add"}';
const tokens: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  usage = new UsageRecorder(t.db);
  model = new FakeModel("claude-sonnet-5-5", usage);
  live = new FakeModel("claude-haiku-5-5", usage);
  const liveLlm: LlmProvider = {
    model: live.model,
    complete: (req) =>
      req.system?.includes("maintain a developer's project memory")
        ? Promise.resolve(verdict(req.prompt))
        : live.complete(req),
  };
  const providers = { ...fakeProviders(), llm: liveLlm, backfillLlm: model };
  app = createApp(t.db, providers);
  tight = createApp(t.db, providers, { backfillBudgetUsd: 0.05 });
  for (const name of ["alice", "bob", "carol", "dave", "erin", "fay"])
    tokens[name] = await createToken(t.db, name);
});
afterAll(() => t.drop());

const call = (
  who: string,
  method: string,
  path: string,
  body?: unknown,
  on = app,
) =>
  on.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const project = { key: "github.com/acme/backfill" };

async function upload(who: string, transcript: string, extra = {}) {
  const res = await call(who, "POST", "/sessions", {
    project,
    transcript,
    source: "backfill",
    agent: "claude",
    ...extra,
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      id: string;
      duplicate?: boolean;
      extracted?: boolean;
      source: string;
    },
  };
}

const extract = async (who: string, id: string, on = app) => {
  const res = await call(who, "POST", `/sessions/${id}/extract`, {}, on);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

const row = async (id: string) =>
  (await t.db.select().from(sessions).where(eq(sessions.id, id)))[0];

describe("backfill upload", () => {
  test("stores a piece scrubbed, with its hash, start time and commit", async () => {
    const transcript =
      "  user: we set DB_PASSWORD=hunter2hunter2 and deploy with make ship  ";
    const r = await upload("alice", transcript, {
      startedAt: "2026-10-01T09:30:00.000Z",
      commitSha: "abc1234",
      sessionKey: "claude-1",
    });
    expect(r.status).toBe(201);
    expect(r.body.source).toBe("backfill");
    const s = await row(r.body.id);
    expect(s).toMatchObject({
      source: "backfill",
      pieceHash: pieceHash(transcript),
      commitSha: "abc1234",
      sessionKey: "claude-1",
      extractedAt: null,
    });
    expect(s?.startedAt?.toISOString()).toBe("2026-10-01T09:30:00.000Z");
    expect(s?.transcript).toBe(
      "user: we set DB_PASSWORD=[REDACTED:env-secret] and deploy with make ship",
    );
  });

  test("a piece sent again is a duplicate however long ago, and says if it was extracted", async () => {
    const first = await upload("alice", "user: piece kept forever");
    expect(first.status).toBe(201);
    await t.db
      .update(sessions)
      .set({ createdAt: new Date("2025-01-01T00:00:00Z") })
      .where(eq(sessions.id, first.body.id));
    const again = await upload("alice", "user: piece kept forever\n");
    expect(again).toMatchObject({
      status: 200,
      body: { id: first.body.id, duplicate: true, extracted: false },
    });
    expect((await extract("alice", first.body.id)).status).toBe(200);
    expect(
      (await upload("alice", "user: piece kept forever")).body,
    ).toMatchObject({ id: first.body.id, duplicate: true, extracted: true });
    // Dedupe is per person: bob's copy is his own piece.
    const bobs = await upload("bob", "user: piece kept forever");
    expect(bobs.status).toBe(201);
    expect(bobs.body.id).not.toBe(first.body.id);
  });

  test("two uploads of one piece at once store it once", async () => {
    const [a, b] = await Promise.all([
      upload("alice", "user: raced upload"),
      upload("alice", "user: raced upload"),
    ]);
    expect(a.body.id).toBe(b.body.id);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
  });
});

describe("backfill extraction", () => {
  test("runs on the backfill model with a scrubbed transcript, records usage as backfill, and runs once", async () => {
    const { body } = await upload(
      "fay",
      "user: token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 and we use pnpm",
    );
    const calls = model.prompts.length;
    const r = await extract("fay", body.id);
    expect(r).toEqual({
      status: 200,
      body: { saved: 1, updated: 0, costUsd: 0.03 },
    });
    expect(model.prompts.length).toBe(calls + 1);
    const prompt = model.prompts.at(-1) as string;
    expect(prompt).toContain("[REDACTED:");
    expect(prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(
      await t.db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.principal, "fay")),
    ).toMatchObject([
      {
        operation: "backfill",
        model: "claude-sonnet-5-5",
        inputTokens: 10_000,
        outputTokens: 1_000,
        costMicros: 30_000,
      },
    ]);
    expect((await row(body.id))?.extractedAt).toBeInstanceOf(Date);
    const [m] = await t.db
      .select()
      .from(memories)
      .where(eq(memories.sessionId, body.id));
    expect(m).toMatchObject({ owner: "fay", status: "active" });

    // Extracted already: the earlier counts, no model call, no cost.
    expect(await extract("fay", body.id)).toEqual({
      status: 200,
      body: { saved: 1, updated: 0, costUsd: 0, alreadyExtracted: true },
    });
    expect(model.prompts.length).toBe(calls + 1);
  });

  test("live extraction from the hooks keeps the live model", async () => {
    const res = await call("fay", "POST", "/sessions", {
      project,
      transcript: "user: a live session about qq caching",
    });
    const { id } = (await res.json()) as { id: string };
    const before = { live: live.prompts.length, model: model.prompts.length };
    expect((await extract("fay", id)).status).toBe(200);
    expect(live.prompts.length).toBe(before.live + 1);
    expect(model.prompts.length).toBe(before.model);
    expect((await row(id))?.extractedAt).toBeNull();
    const ops = await t.db
      .select({ op: usageEvents.operation, model: usageEvents.model })
      .from(usageEvents)
      .where(eq(usageEvents.model, "claude-haiku-5-5"));
    expect(ops).toContainEqual({ op: "sessions", model: "claude-haiku-5-5" });
    expect(ops.map((o) => o.op)).not.toContain("backfill");
  });

  test("two extractions of one piece at once run the model once", async () => {
    const { body } = await upload("alice", "user: concurrent piece");
    const calls = model.prompts.length;
    const held = model.hold();
    const first = extract("alice", body.id);
    await held.started;
    expect(await extract("alice", body.id)).toEqual({
      status: 409,
      body: { error: "piece is being extracted" },
    });
    held.release();
    expect(await first).toMatchObject({ status: 200, body: { saved: 1 } });
    expect(await extract("alice", body.id)).toMatchObject({
      status: 200,
      body: { saved: 1, alreadyExtracted: true },
    });
    expect(model.prompts.length).toBe(calls + 1);
    expect(
      await t.db.select().from(memories).where(eq(memories.sessionId, body.id)),
    ).toHaveLength(1);
  });

  test("a failed extraction leaves the piece for the next try", async () => {
    const { body } = await upload("alice", "user: flaky piece");
    model.fail = true;
    expect((await extract("alice", body.id)).status).toBe(502);
    expect(await row(body.id)).toMatchObject({
      extractedAt: null,
      extractingAt: null,
    });
    expect((await extract("alice", body.id)).status).toBe(200);
  });

  test("an abandoned claim is taken over after 15 minutes", async () => {
    const { body } = await upload("alice", "user: abandoned piece");
    await t.db
      .update(sessions)
      .set({ extractingAt: new Date() })
      .where(eq(sessions.id, body.id));
    expect((await extract("alice", body.id)).status).toBe(409);
    await t.db
      .update(sessions)
      .set({ extractingAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(sessions.id, body.id));
    expect((await extract("alice", body.id)).status).toBe(200);
  });

  test.each([
    ["finishes", false],
    ["fails", true],
  ])(
    "a request whose claim expired and %s leaves the new claim alone",
    async (_n, fails) => {
      const { body } = await upload("alice", `user: expired claim piece ${_n}`);
      const a = model.hold();
      const first = extract("alice", body.id);
      await a.started;
      // A's claim goes stale while its model call is still out.
      await t.db
        .update(sessions)
        .set({ extractingAt: new Date(Date.now() - 16 * 60_000) })
        .where(eq(sessions.id, body.id));
      const b = model.hold();
      const second = extract("alice", body.id);
      await b.started;
      const claimB = (await row(body.id))?.extractingAt;
      expect(claimB?.getTime()).toBeGreaterThan(Date.now() - 60_000);

      model.fail = fails;
      a.release();
      expect((await first).status).toBe(fails ? 502 : 409);
      expect(await row(body.id)).toMatchObject({
        extractedAt: null,
        extractingAt: claimB,
      });

      b.release();
      expect(await second).toMatchObject({ status: 200 });
      expect(await row(body.id)).toMatchObject({ extractingAt: null });
      expect((await row(body.id))?.extractedAt).toBeInstanceOf(Date);
    },
  );

  test("refuses once the budget is reached mid-run, without extracting the rest", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3])
      ids.push((await upload("carol", `user: budget piece ${n}`, {})).body.id);
    const calls = model.prompts.length;
    const [a, b, c] = ids as [string, string, string];
    expect((await extract("carol", a, tight)).status).toBe(200);
    // $0.03 spent of $0.05: still under, so this one runs and goes over.
    expect((await extract("carol", b, tight)).status).toBe(200);
    expect(await extract("carol", c, tight)).toEqual({
      status: 402,
      body: {
        error: "backfill budget used up",
        spentUsd: 0.06,
        budgetUsd: 0.05,
      },
    });
    expect(model.prompts.length).toBe(calls + 2);
    expect(await row(c)).toMatchObject({
      extractedAt: null,
      extractingAt: null,
    });
    // A finished piece still answers, since it costs nothing.
    expect((await extract("carol", a, tight)).status).toBe(200);
    const plan = await call(
      "carol",
      "POST",
      "/backfill/plan",
      { project, pieces: [] },
      tight,
    );
    expect(await plan.json()).toMatchObject({
      spentUsd: 0.06,
      budgetUsd: 0.05,
    });
  });
});

describe("POST /backfill/plan", () => {
  test("sorts pieces into new, done and live, and prices only the new ones", async () => {
    const done = "user: dave's done piece";
    const stored = "user: dave's stored but unextracted piece";
    const unsent = "user: dave's unsent piece";
    const d = await upload("dave", done);
    expect((await extract("dave", d.body.id)).status).toBe(200);
    await upload("dave", stored);
    await call("dave", "POST", "/sessions", {
      project: { key: "github.com/acme/elsewhere" },
      transcript: "user: a hook upload",
      sessionKey: "live-session",
    });
    const pieces = [
      { sessionKey: "s1", hash: pieceHash(done), chars: 4000 },
      { sessionKey: "s2", hash: pieceHash(stored), chars: 4000 },
      { sessionKey: "live-session", hash: pieceHash("other"), chars: 4000 },
      { sessionKey: "s3", hash: pieceHash(unsent), chars: 1_000_000 },
    ];
    const res = await call("dave", "POST", "/backfill/plan", {
      project,
      pieces,
    });
    expect(res.status).toBe(200);
    const plan = (await res.json()) as Record<string, unknown>;
    const promptTokens = Math.ceil(SYSTEM.length / 4);
    // Sonnet 5.5: $2 in, $10 out per million. The 1M-character piece is cut to 60,000 as extraction cuts it.
    const expected =
      ((promptTokens + 1000) * 2 +
        2000 * 10 +
        (promptTokens + 15_000) * 2 +
        2000 * 10) /
      1e6;
    expect(plan).toEqual({
      pieces: [
        { hash: pieceHash(done), status: "done" },
        { hash: pieceHash(stored), status: "new" },
        { hash: pieceHash("other"), status: "live" },
        { hash: pieceHash(unsent), status: "new" },
      ],
      estimateUsd: expected,
      budgetUsd: 10,
      spentUsd: 0.03,
      model: "claude-sonnet-5-5",
    });
    expect(estimateMicros(model, [4000, 1_000_000]) / 1e6).toBe(expected);

    // Someone else's pieces and hook sessions are not yours.
    const theirs = (await (
      await call("bob", "POST", "/backfill/plan", { project, pieces })
    ).json()) as { pieces: { status: string }[]; spentUsd: number };
    expect(theirs.pieces.map((p) => p.status)).toEqual([
      "new",
      "new",
      "new",
      "new",
    ]);
  });

  test("nothing new costs nothing, and an unknown project has nothing done", async () => {
    const done = (await upload("dave", "user: dave's done piece")).body;
    expect(done.duplicate).toBe(true);
    const plan = (await (
      await call("dave", "POST", "/backfill/plan", {
        project: project.key,
        pieces: [{ hash: pieceHash("user: dave's done piece"), chars: 10 }],
      })
    ).json()) as { estimateUsd: number; pieces: { status: string }[] };
    expect(plan).toMatchObject({
      estimateUsd: 0,
      pieces: [{ status: "done" }],
    });
    const fresh = (await (
      await call("dave", "POST", "/backfill/plan", {
        project: "github.com/acme/never-seen",
        pieces: [{ hash: pieceHash("user: dave's done piece"), chars: 10 }],
      })
    ).json()) as { pieces: { status: string }[] };
    expect(fresh.pieces).toEqual([
      { hash: pieceHash("user: dave's done piece"), status: "new" },
    ]);
  });

  test.each([
    ["no project", { pieces: [] }],
    ["a bad hash", { project: "x", pieces: [{ hash: "abc", chars: 1 }] }],
    [
      "negative chars",
      { project: "x", pieces: [{ hash: pieceHash("a"), chars: -1 }] },
    ],
  ])("rejects %s", async (_n, body) => {
    expect((await call("dave", "POST", "/backfill/plan", body)).status).toBe(
      400,
    );
  });
});

describe("POST /backfill/undo", () => {
  test("retires live backfill memories in the repo and leaves history alone", async () => {
    // One piece's memory, then a later piece's memory that supersedes it.
    const a = (await upload("erin", "user: piece about deploys")).body;
    model.next = "The deploy target is fly machines";
    expect((await extract("erin", a.id)).body).toMatchObject({ saved: 1 });
    const b = (await upload("erin", "user: later piece about deploys")).body;
    model.next = "The deploy target is render machines";
    verdict = (prompt) => {
      const ids = [...prompt.matchAll(/^\[([0-9a-f-]{36})\]/gm)].map(
        (m) => m[1],
      );
      return JSON.stringify({ action: "supersede", ids });
    };
    try {
      expect((await extract("erin", b.id)).body).toMatchObject({
        saved: 0,
        updated: 1,
      });
    } finally {
      verdict = () => '{"action":"add"}';
    }
    // A memory from a hook session, and one from a backfill of another repo.
    const hook = (await (
      await call("erin", "POST", "/sessions", {
        project,
        transcript: "user: live",
      })
    ).json()) as { id: string };
    const [p] = await t.db
      .select()
      .from(projects)
      .where(eq(projects.key, project.key));
    const [kept] = await t.db
      .insert(memories)
      .values({
        scope: "project",
        projectId: p?.id,
        owner: "erin",
        author: "erin",
        content: "from a live session",
        agent: "extraction",
        sessionId: hook.id,
      })
      .returning();
    const other = await call("erin", "POST", "/sessions", {
      project: { key: "github.com/acme/other" },
      transcript: "user: other repo piece",
      source: "backfill",
    });
    const otherId = ((await other.json()) as { id: string }).id;
    expect((await extract("erin", otherId)).status).toBe(200);

    const res = await call(
      "erin",
      "POST",
      `/backfill/undo?project=${encodeURIComponent(project.key)}`,
    );
    expect(await res.json()).toEqual({ retired: 1 });

    const mine = await t.db
      .select({
        content: memories.content,
        status: memories.status,
        id: memories.id,
      })
      .from(memories)
      .where(eq(memories.owner, "erin"));
    const status = (content: string) =>
      mine.find((m) => m.content === content)?.status;
    expect(status("The deploy target is render machines")).toBe("retired");
    expect(status("The deploy target is fly machines")).toBe("superseded");
    expect(status("from a live session")).toBe("active");
    expect(
      (
        await t.db
          .select()
          .from(memories)
          .where(eq(memories.sessionId, otherId))
      )[0]?.status,
    ).toBe("active");
    const retiredId = mine.find(
      (m) => m.content === "The deploy target is render machines",
    )?.id as string;
    expect(
      await t.db
        .select()
        .from(memoryEvents)
        .where(
          and(
            eq(memoryEvents.memoryId, retiredId),
            eq(memoryEvents.kind, "retired"),
          ),
        ),
    ).toMatchObject([
      {
        actor: "person",
        principal: "erin",
        sessionId: b.id,
        reason: "backfill undone",
        detail: { previous: { status: "active" } },
      },
    ]);
    expect(kept?.status).toBe("active");

    // Rows are kept, and a second undo has nothing left to retire.
    const again = await call(
      "erin",
      "POST",
      `/backfill/undo?project=${encodeURIComponent(project.key)}`,
    );
    expect(await again.json()).toEqual({ retired: 0 });
    // Nobody else can undo erin's backfill.
    const bob = await call(
      "bob",
      "POST",
      `/backfill/undo?project=github.com%2Facme%2Fother`,
    );
    expect(await bob.json()).toEqual({ retired: 0 });
  });

  test("needs a project, and an unknown one is not found", async () => {
    expect((await call("erin", "POST", "/backfill/undo")).status).toBe(400);
    const res = await call("erin", "POST", "/backfill/undo?project=nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project not found" });
  });

  test("someone who lost access to the repo can't undo there", async () => {
    const repos = new Set([project.key]);
    const repoAccess = {
      reposFor: async () => new Set(repos),
    } as unknown as RepoAccess;
    const gated = createApp(
      t.db,
      { ...fakeProviders(), backfillLlm: model },
      { repoAccess },
    );
    const [gus] = await t.db
      .insert(users)
      .values({ githubId: 106, login: "gus" })
      .returning();
    tokens.gus = await createToken(t.db, "gus", { userId: gus?.id });
    const res = await call(
      "gus",
      "POST",
      "/sessions",
      { project, transcript: "user: gus's piece", source: "backfill" },
      gated,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    model.next = "Gus's backfilled memory";
    expect((await extract("gus", id, gated)).status).toBe(200);

    repos.clear();
    const undo = await call(
      "gus",
      "POST",
      `/backfill/undo?project=${encodeURIComponent(project.key)}`,
      undefined,
      gated,
    );
    expect(undo.status).toBe(404);
    expect(await undo.json()).toEqual({ error: "project not found" });
    const [m] = await t.db
      .select({ status: memories.status })
      .from(memories)
      .where(eq(memories.sessionId, id));
    expect(m?.status).toBe("active");

    // With access back, the same call retires it.
    repos.add(project.key);
    const back = await call(
      "gus",
      "POST",
      `/backfill/undo?project=${encodeURIComponent(project.key)}`,
      undefined,
      gated,
    );
    expect(await back.json()).toEqual({ retired: 1 });
  });
});
