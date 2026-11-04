import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { loadConfig } from "./config.js";
import { apiTokens } from "./db/schema.js";
import { createTestDb } from "./test-db.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  t = await createTestDb();
  app = createApp(t.db);
  token = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

const get = (path: string, auth?: string) =>
  app.request(path, { headers: auth ? { authorization: auth } : {} });

test("GET /health needs no token", async () => {
  const res = await get("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

describe("bearer auth", () => {
  test("rejects a request with no token", async () => {
    expect((await get("/api/whoami")).status).toBe(401);
  });

  test("rejects an unknown token", async () => {
    expect((await get("/api/whoami", "Bearer imp_nope")).status).toBe(401);
  });

  test("rejects a non-bearer scheme", async () => {
    expect((await get("/api/whoami", `Basic ${token}`)).status).toBe(401);
  });

  test("accepts a valid token and identifies its owner", async () => {
    const res = await get("/api/whoami", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "alice" });
  });

  test("stores only a hash, never the token", async () => {
    const rows = await t.db.select().from(apiTokens);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  test("rejects a revoked token", async () => {
    const revoked = await createToken(t.db, "bob");
    await t.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(apiTokens.name, "bob"));
    expect((await get("/api/whoami", `Bearer ${revoked}`)).status).toBe(401);
  });
});

describe("loadConfig", () => {
  test("defaults", () => {
    expect(loadConfig({})).toMatchObject({ port: 3000 });
  });
  test("reads env", () => {
    expect(loadConfig({ PORT: "8080", DATABASE_URL: "postgres://x" })).toEqual({
      port: 8080,
      databaseUrl: "postgres://x",
    });
  });
  test("rejects a bad port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
  });
});
