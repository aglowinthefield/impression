import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { users } from "./db/schema.js";
import type { RepoAccess } from "./repo-access.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let samWeb: string;
let kimWeb: string;
let admin: string;

beforeAll(async () => {
  t = await createTestDb();
  const repoAccess = {
    reposFor: async () => new Set(["github.com/sam/app", "github.com/sam/lib"]),
  } as unknown as RepoAccess;
  app = createApp(t.db, fakeProviders(), { repoAccess });
  const [s, k] = await t.db
    .insert(users)
    .values([
      { githubId: 1, login: "sam" },
      { githubId: 2, login: "kim" },
    ])
    .returning();
  samWeb = await createToken(t.db, "sam", { userId: s?.id, source: "web" });
  await createToken(t.db, "sam", { userId: s?.id, source: "cli" });
  kimWeb = await createToken(t.db, "kim", { userId: k?.id, source: "web" });
  admin = await createToken(t.db, "ops");
});
afterAll(() => t.drop());

const get = async (token: string, path = "/api/setup") =>
  (await app.request(path, {
    headers: { authorization: `Bearer ${token}` },
  })) as Response;

test("reports reachable repos, a signed-in CLI, sessions and memories", async () => {
  const sam = await (await get(samWeb)).json();
  expect(sam).toEqual({
    name: "sam",
    admin: false,
    repos: 2,
    cliSignedIn: true,
    sessions: 0,
    memories: 0,
  });
  const kim = await (await get(kimWeb)).json();
  expect(kim.cliSignedIn).toBe(false);

  await app.request("/api/memories", {
    method: "POST",
    headers: {
      authorization: `Bearer ${samWeb}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content: "Run pnpm test before pushing",
      scope: "project",
      project: { key: "github.com/sam/app" },
    }),
  });
  expect((await (await get(samWeb)).json()).memories).toBe(1);
  expect((await (await get(kimWeb)).json()).memories).toBe(0);
});

test("says whether a project key is reachable", async () => {
  const at = (token: string, key: string) =>
    get(token, `/api/setup?project=${encodeURIComponent(key)}`).then(
      async (r) => (await r.json()).project,
    );
  expect(await at(samWeb, "github.com/Sam/App")).toEqual({
    key: "github.com/Sam/App",
    reachable: true,
  });
  expect((await at(samWeb, "github.com/acme/secret")).reachable).toBe(false);
  expect((await at(samWeb, "path:/home/sam/notes")).reachable).toBe(true);
  expect((await at(admin, "github.com/acme/secret")).reachable).toBe(true);
});

test("whoami says who is an admin, and only admins see failed-auth requests", async () => {
  expect(await (await get(admin, "/api/whoami")).json()).toEqual({
    name: "ops",
    admin: true,
  });
  expect(await (await get(samWeb, "/api/whoami")).json()).toEqual({
    name: "sam",
    admin: false,
  });
  await get("imp_nope", "/api/whoami");
  const rows = async (token: string) =>
    (
      (await (await get(token, "/api/debug/requests")).json()) as {
        items: { principal: string | null }[];
      }
    ).items;
  expect((await rows(admin)).some((e) => e.principal === null)).toBe(true);
  expect((await rows(samWeb)).every((e) => e.principal === "sam")).toBe(true);
});
