import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
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

const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const project = { key: "github.com/acme/evals" };
const turn = (n: number, injected: string[]) => ({
  project,
  agentSessionId: "s1",
  turnIndex: n,
  prompt: `prompt ${n}`,
  reply: "reply",
  injected,
  at: "2026-01-01T00:00:00.000Z",
});

test("pushing turns, rating them, and re-pushing keeps ratings", async () => {
  const mem = await call(alice, "POST", "/memories", {
    scope: "project",
    project,
    content: "Run pnpm install first",
  });
  expect(mem.status).toBe(201);
  const push = await call(alice, "POST", "/evals/turns", {
    turns: [
      turn(0, ["Run pnpm install first", "Something unstored"]),
      turn(1, []),
    ],
  });
  expect(await push.json()).toEqual({ stored: 2 });

  const list = (await (
    await call(
      alice,
      "GET",
      `/evals/turns?project=${encodeURIComponent(project.key)}`,
    )
  ).json()) as {
    items: {
      id: string;
      injected: {
        text: string;
        memoryId: string | null;
        rating: string | null;
      }[];
    }[];
  };
  expect(list.items).toHaveLength(1);
  const first = list.items[0] as (typeof list.items)[number];
  expect(first.injected[0]?.memoryId).not.toBeNull();
  expect(first.injected[1]?.memoryId).toBeNull();

  const rate = await call(alice, "PUT", `/evals/turns/${first.id}/rating`, {
    memory: "Run pnpm install first",
    rating: "useful",
  });
  expect(rate.status).toBe(200);
  await call(alice, "POST", "/evals/turns", {
    turns: [turn(0, ["Run pnpm install first", "Something unstored"])],
  });
  const again = (await (
    await call(alice, "GET", "/evals/turns")
  ).json()) as typeof list;
  expect(again.items[0]?.injected[0]?.rating).toBe("useful");

  const unrated = (await (
    await call(alice, "GET", "/evals/turns?unrated=true")
  ).json()) as typeof list;
  expect(unrated.items).toHaveLength(1);

  const stats = (await (
    await call(
      alice,
      "GET",
      `/evals/memories?project=${encodeURIComponent(project.key)}`,
    )
  ).json()) as {
    items: { content: string; injected: number; useful: number }[];
  };
  expect(
    stats.items.find((m) => m.content === "Run pnpm install first"),
  ).toMatchObject({
    injected: 1,
    useful: 1,
  });
});

test("turns are private to their owner and ratings validate", async () => {
  const bobs = (await (await call(bob, "GET", "/evals/turns")).json()) as {
    items: unknown[];
  };
  expect(bobs.items).toHaveLength(0);
  const list = (await (await call(alice, "GET", "/evals/turns")).json()) as {
    items: { id: string }[];
  };
  const id = list.items[0]?.id ?? "";
  expect(
    (
      await call(bob, "PUT", `/evals/turns/${id}/rating`, {
        memory: "x",
        rating: "useful",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(alice, "PUT", `/evals/turns/${id}/rating`, {
        memory: "Something unstored",
        rating: "great",
      })
    ).status,
  ).toBe(400);
});

test("rating extraction output as good or junk", async () => {
  const created = (await (
    await call(alice, "POST", "/memories", {
      scope: "project",
      project,
      content: "Always run db:reembed after changing the embedding model",
      agent: "extraction",
    })
  ).json()) as { id: string };
  expect(
    (
      await call(alice, "PUT", `/evals/extraction/${created.id}`, {
        rating: "junk",
      })
    ).status,
  ).toBe(200);
  const list = (await (
    await call(
      alice,
      "GET",
      `/evals/extraction?project=${encodeURIComponent(project.key)}`,
    )
  ).json()) as { items: { id: string; rating: string | null }[] };
  expect(list.items.find((m) => m.id === created.id)?.rating).toBe("junk");
  await call(alice, "PUT", `/evals/extraction/${created.id}`, { rating: null });
  const cleared = (await (
    await call(alice, "GET", "/evals/extraction")
  ).json()) as typeof list;
  expect(cleared.items.find((m) => m.id === created.id)?.rating).toBeNull();
});

test("a memory injected twice in one turn is listed once", async () => {
  await call(alice, "POST", "/evals/turns", {
    turns: [
      {
        ...turn(7, ["Dup memory", "Dup memory", "Other"]),
        project: { key: "github.com/acme/dups" },
        agentSessionId: "dup",
      },
    ],
  });
  const res = (await (
    await call(
      alice,
      "GET",
      `/evals/turns?project=${encodeURIComponent("github.com/acme/dups")}`,
    )
  ).json()) as { items: { prompt: string; injected: { text: string }[] }[] };
  const item = res.items.find((i) => i.prompt === "prompt 7");
  expect(item?.injected.map((i) => i.text)).toEqual(["Dup memory", "Other"]);
});
