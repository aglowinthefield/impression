import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { sessions } from "./db/schema.js";
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
  app.request(`/api/sessions${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const project = { key: "github.com/acme/sess" };

test("stores a scrubbed session and returns metadata, not the transcript", async () => {
  const res = await call(alice, "POST", "", {
    project,
    transcript: "we set DB_PASSWORD=hunter2hunter2 then ran make db-migrate",
    commitSha: "abc1234",
    agent: "pi",
  });
  expect(res.status).toBe(201);
  const s = (await res.json()) as {
    id: string;
    transcriptChars: number;
    redactions: unknown;
  };
  expect(s).toMatchObject({
    project: project.key,
    owner: "alice",
    agent: "pi",
    commitSha: "abc1234",
  });
  expect(s.redactions).toEqual([{ type: "env-secret", count: 1 }]);
  const [row] = await t.db.select().from(sessions).where(eq(sessions.id, s.id));
  expect(row?.transcript).toBe(
    "we set DB_PASSWORD=[REDACTED:env-secret] then ran make db-migrate",
  );
});

test.each([
  ["empty transcript", { project, transcript: " " }],
  ["missing project", { transcript: "x" }],
  ["bad sha", { project, transcript: "x", commitSha: "main" }],
])("rejects %s", async (_n, body) => {
  expect((await call(alice, "POST", "", body)).status).toBe(400);
});

test("sessions are visible only to their owner", async () => {
  const s = (await (
    await call(alice, "POST", "", { project, transcript: "private" })
  ).json()) as { id: string };
  expect((await call(alice, "GET", `/${s.id}`)).status).toBe(200);
  expect((await call(bob, "GET", `/${s.id}`)).status).toBe(404);
  const mine = (await (
    await call(alice, "GET", `?project=${project.key}`)
  ).json()) as { items: { id: string }[] };
  expect(mine.items.map((i) => i.id)).toContain(s.id);
  expect(
    ((await (await call(bob, "GET", "")).json()) as { items: unknown[] }).items,
  ).toEqual([]);
});
