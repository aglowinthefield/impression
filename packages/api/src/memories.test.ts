import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { anchors, memories } from "./db/schema.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let alice: string;
let bob: string;

beforeAll(async () => {
  t = await createTestDb();
  app = createApp(t.db, fakeProviders());
  alice = await createToken(t.db, "alice");
  bob = await createToken(t.db, "bob");
});
afterAll(() => t.drop());

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(`/api/memories${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const project = { key: "github.com/acme/app" };

describe("create", () => {
  test("stores a project memory with provenance and creates the project", async () => {
    const res = await call(alice, "POST", "", {
      scope: "project",
      project,
      content: "Migrations run via make db-migrate",
      agent: "pi",
      pathPrefix: "packages/api",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      scope: "project",
      project: "github.com/acme/app",
      content: "Migrations run via make db-migrate",
      owner: "alice",
      author: "alice",
      agent: "pi",
      status: "active",
      pathPrefix: "packages/api",
    });
  });

  test("a second memory reuses the same project", async () => {
    await call(alice, "POST", "", {
      scope: "project",
      project,
      content: "second",
    });
    const list = await (
      await call(alice, "GET", `?project=${project.key}`)
    ).json();
    expect(list.items.length).toBeGreaterThanOrEqual(2);
  });

  test.each([
    ["project scope without a project", { scope: "project", content: "x" }],
    ["user scope with a project", { scope: "user", project, content: "x" }],
    ["team scope", { scope: "team", project, content: "x" }],
    ["empty content", { scope: "user", content: "   " }],
    ["a non-JSON body", undefined],
  ])("rejects %s", async (_name, body) => {
    expect((await call(alice, "POST", "", body)).status).toBe(400);
  });
});

describe("visibility", () => {
  test("a user memory is hidden from other tokens, a project memory is shared", async () => {
    const mine = await (
      await call(alice, "POST", "", { scope: "user", content: "I prefer pnpm" })
    ).json();
    const shared = await (
      await call(alice, "POST", "", {
        scope: "project",
        project,
        content: "shared",
      })
    ).json();

    expect((await call(bob, "GET", `/${mine.id}`)).status).toBe(404);
    expect(
      (await call(bob, "PATCH", `/${mine.id}`, { pinned: true })).status,
    ).toBe(404);
    expect((await call(bob, "DELETE", `/${mine.id}`)).status).toBe(404);
    expect((await call(bob, "GET", `/${shared.id}`)).status).toBe(200);

    const bobsList = await (await call(bob, "GET", "?scope=user")).json();
    expect(bobsList.items.map((m: { id: string }) => m.id)).not.toContain(
      mine.id,
    );
  });
});

describe("read, update, delete", () => {
  test("gets one memory, and 404s on unknown or malformed ids", async () => {
    const m = await (
      await call(alice, "POST", "", { scope: "user", content: "findable" })
    ).json();
    expect(await (await call(alice, "GET", `/${m.id}`)).json()).toMatchObject({
      content: "findable",
    });
    expect(
      (await call(alice, "GET", "/00000000-0000-4000-8000-000000000000"))
        .status,
    ).toBe(404);
    expect((await call(alice, "GET", "/not-a-uuid")).status).toBe(404);
  });

  test("patching content re-embeds it, patching a flag leaves the vector alone", async () => {
    const m = await (
      await call(alice, "POST", "", { scope: "user", content: "old text" })
    ).json();
    const sentinel = new Array(768).fill(0.1);
    await t.db
      .update(memories)
      .set({ embedding: sentinel, embeddingModel: "m", embeddingDim: 768 })
      .where(eq(memories.id, m.id));

    await call(alice, "PATCH", `/${m.id}`, { pinned: true });
    let [row] = await t.db.select().from(memories).where(eq(memories.id, m.id));
    expect(row?.embeddingModel).toBe("m");

    const res = await call(alice, "PATCH", `/${m.id}`, { content: "new text" });
    expect(await res.json()).toMatchObject({
      content: "new text",
      pinned: true,
      embeddingModel: "fake-bow",
    });
    [row] = await t.db.select().from(memories).where(eq(memories.id, m.id));
    expect(row?.embedding).not.toEqual(sentinel);
  });

  test("rejects an empty patch", async () => {
    const m = await (
      await call(alice, "POST", "", { scope: "user", content: "x" })
    ).json();
    expect((await call(alice, "PATCH", `/${m.id}`, {})).status).toBe(400);
  });

  test("won't edit a superseded memory", async () => {
    const m = await (
      await call(alice, "POST", "", { scope: "user", content: "gone" })
    ).json();
    await t.db
      .update(memories)
      .set({ status: "superseded" })
      .where(eq(memories.id, m.id));
    expect(
      (await call(alice, "PATCH", `/${m.id}`, { content: "edit" })).status,
    ).toBe(409);
  });

  test("delete retires by default and hides it from the default list, hard delete removes the row", async () => {
    const m = await (
      await call(alice, "POST", "", { scope: "user", content: "to retire" })
    ).json();
    const del = await call(alice, "DELETE", `/${m.id}`);
    expect(await del.json()).toMatchObject({ status: "retired" });

    const def = await (await call(alice, "GET", "?scope=user")).json();
    expect(def.items.map((x: { id: string }) => x.id)).not.toContain(m.id);
    const retired = await (
      await call(alice, "GET", "?scope=user&status=retired")
    ).json();
    expect(retired.items.map((x: { id: string }) => x.id)).toContain(m.id);

    expect((await call(alice, "DELETE", `/${m.id}?hard=true`)).status).toBe(
      204,
    );
    expect((await call(alice, "GET", `/${m.id}`)).status).toBe(404);
  });
});

describe("list", () => {
  test("filters by pinned and project, pages, and returns newest first", async () => {
    const p2 = { key: "github.com/acme/other" };
    const ids: string[] = [];
    for (const c of ["one", "two", "three"]) {
      const r = await (
        await call(alice, "POST", "", {
          scope: "project",
          project: p2,
          content: c,
          pinned: c === "two",
        })
      ).json();
      ids.push(r.id);
    }
    const all = await (
      await call(alice, "GET", `?scope=project&project=${p2.key}`)
    ).json();
    expect(all.items.map((m: { content: string }) => m.content)).toEqual([
      "three",
      "two",
      "one",
    ]);

    const pinned = await (
      await call(alice, "GET", `?scope=project&project=${p2.key}&pinned=true`)
    ).json();
    expect(pinned.items.map((m: { content: string }) => m.content)).toEqual([
      "two",
    ]);

    const page = await (
      await call(
        alice,
        "GET",
        `?scope=project&project=${p2.key}&limit=1&offset=1`,
      )
    ).json();
    expect(page.items.map((m: { content: string }) => m.content)).toEqual([
      "two",
    ]);

    expect(
      (
        await (
          await call(alice, "GET", "?project=github.com/nobody/none")
        ).json()
      ).items,
    ).toEqual([]);
    expect((await call(alice, "GET", "?limit=0")).status).toBe(400);
  });
});

describe("anchors", () => {
  const sha = "a1b2c3d4e5f6";
  test("are stored on create and returned by get, list and search", async () => {
    const res = await call(alice, "POST", "", {
      scope: "project",
      project,
      content: "Auth middleware lives in the gateway",
      anchors: [
        { path: "./src/auth.ts", symbol: "requireAuth", commitSha: sha },
        { path: "src/z.md", commitSha: sha },
      ],
    });
    expect(res.status).toBe(201);
    const m = await res.json();
    expect(m.anchors).toMatchObject([
      { path: "src/auth.ts", symbol: "requireAuth", commitSha: sha },
      { path: "src/z.md", symbol: null, commitSha: sha },
    ]);
    expect(
      (await (await call(alice, "GET", `/${m.id}`)).json()).anchors,
    ).toHaveLength(2);
    const list = await (
      await call(alice, "GET", `?project=${project.key}`)
    ).json();
    expect(
      list.items.find((x: { id: string }) => x.id === m.id).anchors,
    ).toHaveLength(2);
    const found = await (
      await app.request("/api/search", {
        method: "POST",
        headers: {
          authorization: `Bearer ${alice}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: "auth middleware gateway",
          project: project.key,
        }),
      })
    ).json();
    expect(
      found.results.find((x: { id: string }) => x.id === m.id).anchors,
    ).toHaveLength(2);
  });

  test("memories without anchors return an empty list", async () => {
    const m = await (
      await call(alice, "POST", "", {
        scope: "user",
        content: "no anchors here",
      })
    ).json();
    expect(m.anchors).toEqual([]);
  });

  test.each([
    ["absolute path", { path: "/etc/passwd", commitSha: sha }],
    ["parent traversal", { path: "../x.ts", commitSha: sha }],
    ["bad sha", { path: "a.ts", commitSha: "main" }],
    ["empty path", { path: " ", commitSha: sha }],
  ])("rejects %s", async (_n, anchor) => {
    const res = await call(alice, "POST", "", {
      scope: "user",
      content: "x anchor",
      anchors: [anchor],
    });
    expect(res.status).toBe(400);
  });

  test("are deleted with the memory", async () => {
    const m = await (
      await call(alice, "POST", "", {
        scope: "user",
        content: "gone soon",
        anchors: [{ path: "a.ts", commitSha: sha }],
      })
    ).json();
    await call(alice, "DELETE", `/${m.id}?hard=true`);
    const rows = await t.db
      .select()
      .from(anchors)
      .where(eq(anchors.memoryId, m.id));
    expect(rows).toEqual([]);
  });
});

describe("staleness", () => {
  const stale = (token: string, id: string, body: unknown) =>
    call(token, "PUT", `/${id}/staleness`, body);

  test("flags a memory with a reason, and clears it", async () => {
    const m = await (
      await call(alice, "POST", "", { scope: "user", content: "flaggable" })
    ).json();
    const res = await stale(alice, m.id, {
      stale: true,
      reason: "src/a.ts changed",
    });
    expect(await res.json()).toMatchObject({
      status: "possibly_stale",
      staleReason: "src/a.ts changed",
    });
    expect(
      await (await stale(alice, m.id, { stale: false })).json(),
    ).toMatchObject({
      status: "active",
      staleReason: null,
    });
  });

  test("rejects a missing reason, other people's memories and retired ones", async () => {
    const m = await (
      await call(alice, "POST", "", { scope: "user", content: "mine only" })
    ).json();
    expect((await stale(alice, m.id, { stale: true })).status).toBe(400);
    expect((await stale(bob, m.id, { stale: true, reason: "x" })).status).toBe(
      404,
    );
    await call(alice, "DELETE", `/${m.id}`);
    expect(
      (await stale(alice, m.id, { stale: true, reason: "x" })).status,
    ).toBe(409);
  });
});

describe("review queue", () => {
  test("lists flagged memories, and each outcome resolves one", async () => {
    const mk = async (content: string) =>
      (await (
        await call(alice, "POST", "", { scope: "user", content, dedup: false })
      ).json()) as { id: string };
    const flag = (id: string) =>
      call(alice, "PUT", `/${id}/staleness`, {
        stale: true,
        reason: "src/x.ts changed",
      });
    const [a, b, c] = [
      await mk("review confirm"),
      await mk("review update"),
      await mk("review retire"),
    ];
    for (const m of [a, b, c]) await flag((m as { id: string }).id);

    const ids = async () =>
      (
        (await (await call(alice, "GET", "/review")).json()) as {
          items: { id: string }[];
        }
      ).items.map((i) => i.id);
    expect(await ids()).toEqual(expect.arrayContaining([a.id, b.id, c.id]));

    await call(alice, "PUT", `/${a.id}/staleness`, { stale: false });
    await call(alice, "PATCH", `/${b.id}`, {
      content: "review update, rewritten",
    });
    await call(alice, "DELETE", `/${c.id}`);
    const left = await ids();
    expect([a.id, b.id, c.id].some((id) => left.includes(id))).toBe(false);
    expect(await (await call(alice, "GET", `/${b.id}`)).json()).toMatchObject({
      status: "active",
      staleReason: null,
    });
  });

  test("another token doesn't see my user memories", async () => {
    const m = (await (
      await call(alice, "POST", "", {
        scope: "user",
        content: "private flagged",
      })
    ).json()) as { id: string };
    await call(alice, "PUT", `/${m.id}/staleness`, {
      stale: true,
      reason: "r",
    });
    const items = (
      (await (await call(bob, "GET", "/review")).json()) as {
        items: { id: string }[];
      }
    ).items;
    expect(items.map((i) => i.id)).not.toContain(m.id);
  });
});

describe("tags", () => {
  test("filter by tag, and a project filter still lists your user-scoped memories", async () => {
    const tagged = await call(alice, "POST", "", {
      scope: "user",
      content: "Run design sessions against production forks",
      tags: ["Practice", "design", "design"],
    });
    expect(tagged.status).toBe(201);
    expect(((await tagged.json()) as { tags: string[] }).tags).toEqual([
      "practice",
      "design",
    ]);
    await call(alice, "POST", "", {
      scope: "project",
      project,
      content: "Untagged project note",
    });

    const q = encodeURIComponent(project.key);
    const byTag = (await (
      await call(alice, "GET", `?tag=practice&project=${q}`)
    ).json()) as { items: { content: string }[] };
    expect(byTag.items.map((m) => m.content)).toEqual([
      "Run design sessions against production forks",
    ]);
    const inProject = (await (
      await call(alice, "GET", `?project=${q}`)
    ).json()) as { items: { content: string }[] };
    expect(inProject.items.map((m) => m.content)).toEqual(
      expect.arrayContaining([
        "Run design sessions against production forks",
        "Untagged project note",
      ]),
    );
    // Someone else's user-scoped memory never shows up.
    const bobs = (await (
      await call(bob, "GET", `?project=${q}&tag=practice`)
    ).json()) as { items: unknown[] };
    expect(bobs.items).toEqual([]);
    expect(
      (
        await call(alice, "POST", "", {
          scope: "user",
          content: "x",
          tags: ["Bad Tag!"],
        })
      ).status,
    ).toBe(400);
  });
});
