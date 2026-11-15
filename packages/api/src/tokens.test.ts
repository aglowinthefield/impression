import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { apiTokens, users } from "./db/schema.js";
import type { RepoAccess } from "./repo-access.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let sam: string;
let samLaptop: string;
let kim: string;
let admin: string;

beforeAll(async () => {
  t = await createTestDb();
  const repoAccess = {
    reposFor: async () => new Set<string>(),
  } as unknown as RepoAccess;
  app = createApp(t.db, fakeProviders(), { repoAccess });
  const [s, k] = await t.db
    .insert(users)
    .values([
      { githubId: 1, login: "sam" },
      { githubId: 2, login: "kim" },
    ])
    .returning();
  sam = await createToken(t.db, "sam", { userId: s?.id, source: "web" });
  samLaptop = await createToken(t.db, "sam", { userId: s?.id, source: "cli" });
  kim = await createToken(t.db, "kim", { userId: k?.id, source: "cli" });
  admin = await createToken(t.db, "ops");
});
afterAll(() => t.drop());

const call = (token: string, path: string, init: RequestInit = {}) =>
  app.request(`/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "x-impression-client": "pi/0.3.0 (tom-mini)",
      "fly-client-ip": "203.0.113.7",
      ...init.headers,
    },
  });

type Item = {
  id: string;
  name: string;
  source: string;
  current: boolean;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastClient: string | null;
  lastIp: string | null;
  lastRejectedAt: string | null;
  lastRejectedClient: string | null;
};
const list = async (token: string) =>
  ((await (await call(token, "/tokens")).json()) as { items: Item[] }).items;

test("a token records the client, machine and IP that last used it", async () => {
  await call(samLaptop, "/whoami");
  const items = await list(sam);
  expect(items).toHaveLength(2);
  const laptop = items.find((i) => i.source === "cli");
  expect(laptop).toMatchObject({
    current: false,
    lastClient: "pi/0.3.0 (tom-mini)",
    lastIp: "203.0.113.7",
  });
  expect(laptop?.lastUsedAt).toBeTruthy();
  expect(items.find((i) => i.source === "web")?.current).toBe(true);
});

test("a changed client is recorded right away", async () => {
  await call(samLaptop, "/whoami", {
    headers: { "x-impression-client": "mcp/0.3.0 (tom-mini)" },
  });
  const laptop = (await list(sam)).find((i) => i.source === "cli");
  expect(laptop?.lastClient).toBe("mcp/0.3.0 (tom-mini)");
});

test("people see only their own tokens, admins see all", async () => {
  expect((await list(kim)).map((i) => i.name)).toEqual(["kim"]);
  expect((await list(admin)).length).toBe(4);
});

test("revoking a token stops it and records who still tries it", async () => {
  const kimToken = (await list(kim))[0]?.id;
  // Someone else's token looks like it doesn't exist.
  expect(
    (await call(sam, `/tokens/${kimToken}/revoke`, { method: "POST" })).status,
  ).toBe(404);

  const laptop = (await list(sam)).find((i) => i.source === "cli");
  const res = await call(sam, `/tokens/${laptop?.id}/revoke`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const tried = await call(samLaptop, "/whoami", {
    headers: { "x-impression-client": "cli/0.2.0 (old-box)" },
  });
  expect(tried.status).toBe(401);
  const after = (await list(sam)).find((i) => i.source === "cli");
  expect(after?.revokedAt).toBeTruthy();
  expect(after?.lastRejectedClient).toBe("cli/0.2.0 (old-box)");
  expect(after?.lastRejectedAt).toBeTruthy();
  // Revoking twice is a 404.
  expect(
    (await call(sam, `/tokens/${laptop?.id}/revoke`, { method: "POST" }))
      .status,
  ).toBe(404);
});

test("an unknown token records nothing", async () => {
  const res = await call("imp_nope", "/whoami");
  expect(res.status).toBe(401);
  const rows = await t.db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.lastRejectedClient, "pi/0.3.0 (tom-mini)"));
  expect(rows).toEqual([]);
});
