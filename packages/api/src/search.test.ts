import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { memories } from "./db/schema.js";
import { toTsQuery } from "./search.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let providers: ReturnType<typeof fakeProviders>;
let alice: string;
let bob: string;

beforeAll(async () => {
  t = await createTestDb();
  providers = fakeProviders();
  app = createApp(t.db, providers);
  alice = await createToken(t.db, "alice");
  bob = await createToken(t.db, "bob");
});
afterAll(() => t.drop());

function call(token: string, path: string, body?: unknown, method = "POST") {
  return app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const add = async (token: string, body: Record<string, unknown>) =>
  (await (await call(token, "/memories", body)).json()) as { id: string };
const search = async (token: string, body: Record<string, unknown>) =>
  (await (await call(token, "/search", body)).json()) as {
    degraded: boolean;
    results: { id: string; content: string; score: number; stale: boolean }[];
  };

const proj = { key: "github.com/acme/search" };

describe("embed on write", () => {
  test("a new memory gets a vector with its model and dimension", async () => {
    const m = await add(alice, {
      scope: "user",
      content: "embedded on create",
    });
    const [row] = await t.db
      .select()
      .from(memories)
      .where(eq(memories.id, m.id));
    expect(row?.embedding).toHaveLength(1536);
    expect(row).toMatchObject({
      embeddingModel: "fake-bow",
      embeddingDim: 1536,
    });
  });

  test("editing content re-embeds it", async () => {
    const m = await add(alice, { scope: "user", content: "first wording" });
    const before = providers.embedCalls.length;
    await call(
      alice,
      `/memories/${m.id}`,
      { content: "second wording" },
      "PATCH",
    );
    expect(providers.embedCalls.length).toBe(before + 1);
    const [row] = await t.db
      .select()
      .from(memories)
      .where(eq(memories.id, m.id));
    expect(row?.embeddingModel).toBe("fake-bow");
  });

  test("a failing embedding service doesn't lose the memory", async () => {
    const down = createApp(t.db, fakeProviders({ failEmbeddings: true }));
    const res = await down.request("/api/memories", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "user",
        content: "saved without a vector zebra",
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [row] = await t.db.select().from(memories).where(eq(memories.id, id));
    expect(row?.embedding).toBeNull();
    // Still findable by full text.
    const found = await search(alice, { query: "zebra" });
    expect(found.results.map((r) => r.id)).toContain(id);
  });
});

describe("hybrid search", () => {
  test("ranks the closest memory first and returns a score", async () => {
    const hit = await add(alice, {
      scope: "project",
      project: proj,
      content: "database migrations run through make db-migrate",
    });
    await add(alice, {
      scope: "project",
      project: proj,
      content: "frontend styling uses tailwind utility classes",
    });
    await add(alice, {
      scope: "project",
      project: proj,
      content: "deploys go out through flyctl",
    });
    const r = await search(alice, {
      query: "how do I run database migrations",
      project: proj.key,
    });
    expect(r.results[0]?.id).toBe(hit.id);
    expect(r.results[0]?.score).toBeGreaterThan(0);
    expect(r.degraded).toBe(false);
  });

  test("finds an exact keyword the vector would miss", async () => {
    const m = await add(alice, {
      scope: "project",
      project: proj,
      content: "set FLY_API_TOKEN before releasing",
    });
    const r = await search(alice, {
      query: "FLY_API_TOKEN",
      project: proj.key,
    });
    expect(r.results.map((x) => x.id)).toContain(m.id);
  });

  test("falls back to full text when the query embedding fails", async () => {
    const down = createApp(t.db, fakeProviders({ failEmbeddings: true }));
    const res = await down.request("/api/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "migrations", project: proj.key }),
    });
    const r = (await res.json()) as { degraded: boolean; results: unknown[] };
    expect(r.degraded).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
  });

  test("returns nothing for a query with no words", async () => {
    const r = await search(alice, {
      query: "???",
      project: "github.com/acme/empty",
    });
    expect(r.results).toEqual([]);
  });

  test("rejects an empty query", async () => {
    expect((await call(alice, "/search", { query: "  " })).status).toBe(400);
  });
});

describe("filters", () => {
  test("a user memory is invisible to other tokens", async () => {
    const m = await add(alice, {
      scope: "user",
      content: "alice private quokka preference",
    });
    expect(
      (await search(alice, { query: "quokka" })).results.map((r) => r.id),
    ).toContain(m.id);
    expect((await search(bob, { query: "quokka" })).results).toEqual([]);
  });

  test("scope and project narrow results", async () => {
    const p = await add(alice, {
      scope: "project",
      project: { key: "github.com/acme/other" },
      content: "narwhal convention in other repo",
    });
    const u = await add(alice, {
      scope: "user",
      content: "narwhal habit across repos",
    });
    const inOther = await search(alice, {
      query: "narwhal",
      project: "github.com/acme/other",
    });
    expect(inOther.results.map((r) => r.id)).toEqual([p.id]);
    const userOnly = await search(alice, { query: "narwhal", scope: "user" });
    expect(userOnly.results.map((r) => r.id)).toEqual([u.id]);
  });

  test("path keeps unscoped memories and those whose prefix contains the path", async () => {
    const root = await add(alice, {
      scope: "project",
      project: proj,
      content: "ocelot rule for the whole repo",
    });
    const api = await add(alice, {
      scope: "project",
      project: proj,
      content: "ocelot rule for the api package",
      pathPrefix: "packages/api",
    });
    const web = await add(alice, {
      scope: "project",
      project: proj,
      content: "ocelot rule for the web package",
      pathPrefix: "packages/web",
    });
    const ids = async (path: string) =>
      (
        await search(alice, { query: "ocelot", project: proj.key, path })
      ).results.map((r) => r.id);
    const inApi = await ids("packages/api/src");
    expect(inApi).toEqual(expect.arrayContaining([root.id, api.id]));
    expect(inApi).not.toContain(web.id);
    // A sibling directory that only shares a name prefix doesn't match.
    expect(await ids("packages/api-extra")).not.toContain(api.id);
  });

  test("retired memories are hidden unless asked for, stale ones are flagged", async () => {
    const gone = await add(alice, {
      scope: "project",
      project: proj,
      content: "wombat retired fact",
    });
    const stale = await add(alice, {
      scope: "project",
      project: proj,
      content: "wombat stale fact",
    });
    await call(alice, `/memories/${gone.id}`, undefined, "DELETE");
    await t.db
      .update(memories)
      .set({ status: "possibly_stale", staleReason: "src/a.ts changed" })
      .where(eq(memories.id, stale.id));

    const r = await search(alice, { query: "wombat", project: proj.key });
    expect(r.results.map((x) => x.id)).toEqual([stale.id]);
    expect(r.results[0]?.stale).toBe(true);

    const retired = await search(alice, {
      query: "wombat",
      project: proj.key,
      status: "retired",
    });
    expect(retired.results.map((x) => x.id)).toEqual([gone.id]);
  });
});

test("toTsQuery ORs the words and ignores punctuation", () => {
  expect(toTsQuery("How do I run migrations?")).toBe(
    "How or do or I or run or migrations",
  );
  expect(toTsQuery("???")).toBeNull();
});
