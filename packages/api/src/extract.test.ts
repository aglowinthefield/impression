import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { proposals } from "./db/schema.js";
import { parseExtraction } from "./extract.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

describe("parseExtraction", () => {
  test("reads fenced JSON and drops malformed items", () => {
    const r = parseExtraction(
      'ok\n```json\n{"memories":[{"content":"a","confidence":0.9},{"content":"","confidence":1},{"content":"b","confidence":2},{"content":"c","confidence":0.5,"anchors":[{"path":"x.ts"}]}]}\n```',
    );
    expect(r.map((m) => m.content)).toEqual(["a", "c"]);
  });
  test.each(["", "nope", "{bad", '{"memories":3}'])("%j gives []", (x) => {
    expect(parseExtraction(x)).toEqual([]);
  });
});

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let token: string;
let reply = "";
let prompts: string[] = [];
beforeAll(async () => {
  t = await createTestDb();
  const providers = fakeProviders();
  providers.llm = {
    model: "fake",
    complete: async ({ system, prompt }) => {
      prompts.push(prompt);
      // The dedup check has its own system prompt.
      return system?.includes("maintain a developer's project memory")
        ? '{"action":"add"}'
        : reply;
    },
  };
  app = createApp(t.db, providers);
  token = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const project = { key: "github.com/acme/ex" };
const session = async (transcript: string) =>
  (
    (await (
      await call("POST", "/sessions", {
        project,
        transcript,
        commitSha: "abc1234",
      })
    ).json()) as { id: string }
  ).id;

test("accepts scrubbed candidates with anchors at the session commit", async () => {
  reply = JSON.stringify({
    memories: [
      {
        content: "Run make db-migrate before tests",
        confidence: 0.9,
        anchors: [
          { path: "Makefile", symbol: "db-migrate" },
          { path: "/etc/x" },
        ],
      },
      { content: "Use key AKIAIOSFODNN7EXAMPLE for S3", confidence: 0.8 },
      { content: "AKIAIOSFODNN7EXAMPLE", confidence: 0.9 },
      { content: "Maybe the cache is flaky", confidence: 0.5 },
    ],
  });
  const id = await session("long transcript here");
  const res = await call("POST", `/sessions/${id}/extract`);
  expect(await res.json()).toEqual({
    accepted: 2,
    skippedDuplicates: 0,
    skippedEmpty: 1,
    skippedRepeats: 0,
    skippedBelowFloor: 1,
  });
  const rows = await t.db
    .select()
    .from(proposals)
    .where(eq(proposals.sessionId, id));
  expect(rows.map((r) => r.content).sort()).toEqual([
    "Run make db-migrate before tests",
    "Use key [REDACTED:aws-access-key] for S3",
  ]);
  const first = rows.find((r) => r.content.startsWith("Run"));
  expect(first?.anchors).toEqual([
    { path: "Makefile", symbol: "db-migrate", commitSha: "abc1234" },
  ]);
  expect(first?.status).toBe("accepted");
  const mem = (await (
    await call("GET", `/memories/${first?.memoryId}`)
  ).json()) as { content: string; agent: string; anchors: unknown[] };
  expect(mem).toMatchObject({
    content: "Run make db-migrate before tests",
    agent: "extraction",
  });
  expect(mem.anchors).toHaveLength(1);
});

test("skips candidates the project already knows", async () => {
  await call("POST", "/memories", {
    scope: "project",
    project,
    content: "Deploys use flyctl deploy",
    dedup: false,
  });
  const llmDup = fakeProviders();
  const dupApp = createApp(t.db, {
    ...llmDup,
    llm: {
      model: "fake",
      complete: async ({ system }) =>
        system?.includes("maintain a developer's project memory")
          ? JSON.stringify({
              action: "duplicate",
              id: (
                await t.db.query.memories.findFirst({
                  where: (m, { eq }) =>
                    eq(m.content, "Deploys use flyctl deploy"),
                })
              )?.id,
            })
          : JSON.stringify({
              memories: [
                { content: "Deploys use flyctl deploy now", confidence: 0.9 },
              ],
            }),
    },
  });
  const sid = await session("x");
  const res = await dupApp.request(`/api/sessions/${sid}/extract`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await res.json()).toMatchObject({ accepted: 0, skippedDuplicates: 1 });
});

test("sends only the tail of a huge transcript", async () => {
  reply = '{"memories":[]}';
  prompts = [];
  const id = await session(`HEAD${"x".repeat(70_000)}TAIL`);
  await call("POST", `/sessions/${id}/extract`);
  expect(prompts[0]).toContain("TAIL");
  expect(prompts[0]).not.toContain("HEAD");
});

test("another token can't extract my session", async () => {
  const bob = await createToken(t.db, "bob");
  const id = await session("mine");
  const res = await app.request(`/api/sessions/${id}/extract`, {
    method: "POST",
    headers: { authorization: `Bearer ${bob}` },
  });
  expect(res.status).toBe(404);
});

describe("extraction floor", () => {
  const extractOne = async (content: string, confidence: number) => {
    reply = JSON.stringify({ memories: [{ content, confidence }] });
    const id = await session("transcript");
    const res = await call("POST", `/sessions/${id}/extract`);
    return (await res.json()) as Record<string, number>;
  };

  test("drops candidates below the owner's floor", async () => {
    expect(
      await extractOne("Tests need Postgres on 54329", 0.69),
    ).toMatchObject({ accepted: 0, skippedBelowFloor: 1 });
    await call("PUT", "/settings", { extractionFloor: 0.6 });
    expect(
      await extractOne("Tests need Postgres on 54329", 0.69),
    ).toMatchObject({ accepted: 1, skippedBelowFloor: 0 });
    await call("PUT", "/settings", { extractionFloor: 0.7 });
  });

  test("an idea a person rejected in review isn't accepted again", async () => {
    const content = "Lint with biome check";
    const [p] = await t.db.select().from(proposals).limit(1);
    await t.db.insert(proposals).values({
      projectId: p?.projectId as string,
      sessionId: p?.sessionId,
      content,
      confidence: 0.8,
      embedding: (await fakeProviders().embeddings.embed([content]))[0],
      status: "rejected",
      reviewedAt: new Date(),
    });
    expect(await extractOne(content, 0.9)).toMatchObject({
      accepted: 0,
      skippedRepeats: 1,
    });
  });
});

test("a practice is accepted user-scoped and follows the user to other projects", async () => {
  const llm = fakeProviders();
  llm.llm = {
    model: "fake",
    complete: async ({ system }) =>
      system?.includes("maintain a developer's project memory")
        ? '{"action":"add"}'
        : JSON.stringify({
            memories: [
              {
                kind: "practice",
                otherRepos: true,
                content:
                  "When doing a /nitpick design session, run the app against a fork of production data",
                confidence: 0.99,
              },
              {
                kind: "practice",
                otherRepos: false,
                content:
                  "Always run db:reembed after changing the embedding model",
                confidence: 0.99,
              },
            ],
          }),
  };
  const a = createApp(t.db, llm);
  const sid = await session("practice transcript");
  const res = await a.request(`/api/sessions/${sid}/extract`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await res.json()).toMatchObject({ accepted: 2 });
  const rows = await t.db
    .select()
    .from(proposals)
    .where(eq(proposals.sessionId, sid));
  // The repo-specific "practice" is downgraded to a project fact.
  expect(rows.find((r) => r.content.includes("reembed"))?.scope).toBe(
    "project",
  );
  const p = rows.find((r) => r.content.includes("nitpick"));
  const mem = (await (
    await call("GET", `/memories/${p?.memoryId}`)
  ).json()) as { scope: string; project: string | null; tags: string[] };
  expect(mem).toMatchObject({
    scope: "user",
    project: null,
    tags: ["practice"],
  });

  // It shows up at session start in a project the session never touched, first in the list.
  const core = (await (
    await call("GET", "/core?project=github.com%2Facme%2Fother")
  ).json()) as { items: { content: string; tags: string[] }[] };
  expect(core.items[0]?.content).toContain("nitpick");
  expect(core.items[0]?.tags).toEqual(["practice"]);

  // Tags can be filtered and edited.
  const byTag = (await (
    await call("GET", "/memories?tag=practice")
  ).json()) as {
    items: { content: string }[];
  };
  expect(byTag.items.map((m) => m.content)).toEqual([
    expect.stringContaining("nitpick"),
  ]);
});

test("extract passes scrubbed instructions to the model, only when sent", async () => {
  reply = '{"memories":[]}';
  const id = await session("some transcript");
  prompts = [];
  await call("POST", `/sessions/${id}/extract`);
  expect(prompts[0]).not.toContain("Project instructions");
  prompts = [];
  await call("POST", `/sessions/${id}/extract`, {
    instructions: "never push. key AKIAIOSFODNN7EXAMPLE",
  });
  expect(prompts[0]).toContain("never push");
  expect(prompts[0]).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(prompts[0]).toMatch(/Transcript:\nsome transcript$/);
});
