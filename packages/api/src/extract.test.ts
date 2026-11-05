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

test("extracts scrubbed proposals with anchors at the session commit", async () => {
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
      { content: "Use key AKIAIOSFODNN7EXAMPLE for S3", confidence: 0.6 },
      { content: "AKIAIOSFODNN7EXAMPLE", confidence: 0.9 },
    ],
  });
  const id = await session("long transcript here");
  const res = await call("POST", `/sessions/${id}/extract`);
  expect(await res.json()).toEqual({
    proposed: 2,
    skippedDuplicates: 0,
    skippedEmpty: 1,
    skippedRepeats: 0,
    autoAccepted: 0,
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
  expect(first?.status).toBe("pending");
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
  expect(await res.json()).toMatchObject({ proposed: 0, skippedDuplicates: 1 });
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

describe("proposal review", () => {
  const extractOne = async (content: string, confidence = 0.5) => {
    reply = JSON.stringify({ memories: [{ content, confidence }] });
    const id = await session("transcript");
    const res = await call("POST", `/sessions/${id}/extract`);
    return { sid: id, summary: (await res.json()) as Record<string, number> };
  };
  const pending = async () =>
    (await (await call("GET", "/proposals")).json()) as {
      items: { id: string; content: string }[];
    };

  test("accept creates a memory, with an edit if given", async () => {
    await extractOne("Tests need Postgres on 54329");
    const p = (await pending()).items.find((x) => x.content.includes("54329"));
    const res = await call("POST", `/proposals/${p?.id}/accept`, {
      content: "Tests need Postgres on port 54329",
    });
    expect(res.status).toBe(201);
    const mem = (await res.json()) as { content: string; agent: string };
    expect(mem).toMatchObject({
      content: "Tests need Postgres on port 54329",
      agent: "extraction",
    });
    expect((await call("POST", `/proposals/${p?.id}/accept`)).status).toBe(409);
  });

  test("reject hides it and the same idea isn't proposed again", async () => {
    await extractOne("Lint with biome check");
    const p = (await pending()).items.find((x) => x.content.includes("biome"));
    expect((await call("POST", `/proposals/${p?.id}/reject`)).status).toBe(200);
    expect((await pending()).items.some((x) => x.id === p?.id)).toBe(false);
    const again = await extractOne("Lint with biome check");
    expect(again.summary).toMatchObject({ proposed: 0, skippedRepeats: 1 });
  });

  test("high confidence auto-accepts when enabled", async () => {
    const llm = fakeProviders();
    llm.llm = {
      model: "fake",
      complete: async ({ system }) =>
        system?.includes("maintain a developer's project memory")
          ? '{"action":"add"}'
          : JSON.stringify({
              memories: [
                { content: "Zebra cache lives in redis", confidence: 0.95 },
              ],
            }),
    };
    const a = createApp(t.db, llm, { autoAcceptConfidence: 0.8 });
    const sid = await session("x");
    const res = await a.request(`/api/sessions/${sid}/extract`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await res.json()).toMatchObject({ proposed: 1, autoAccepted: 1 });
    const list = (await (
      await call("GET", "/memories?project=github.com/acme/ex")
    ).json()) as { items: { content: string }[] };
    expect(list.items.some((m) => m.content.includes("Zebra"))).toBe(true);
  });
});

test("proposal list shows the session excerpt only to its owner", async () => {
  reply = JSON.stringify({
    memories: [{ content: "Excerpt check memory", confidence: 0.4 }],
  });
  const id = await session(`secret-ish ${"y".repeat(1000)}`);
  await call("POST", `/sessions/${id}/extract`);
  const mine = (await (await call("GET", "/proposals")).json()) as {
    items: { content: string; sessionExcerpt: string | null }[];
  };
  const p = mine.items.find((x) => x.content === "Excerpt check memory");
  expect(p?.sessionExcerpt).toHaveLength(600);
  expect(p?.sessionExcerpt?.startsWith("secret-ish")).toBe(true);
  const bob = await createToken(t.db, "bob2");
  const theirs = (await (
    await app.request("/api/proposals", {
      headers: { authorization: `Bearer ${bob}` },
    })
  ).json()) as { items: { content: string; sessionExcerpt: string | null }[] };
  expect(
    theirs.items.find((x) => x.content === "Excerpt check memory")
      ?.sessionExcerpt,
  ).toBeNull();
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
