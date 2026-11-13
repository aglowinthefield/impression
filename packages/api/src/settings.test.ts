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

const call = (token: string, method: string, body?: unknown) =>
  app.request("/api/settings", {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("the extraction floor defaults to 0.7 and is per person", async () => {
  expect(await (await call(alice, "GET")).json()).toEqual({
    extractionFloor: 0.7,
  });
  const put = await call(alice, "PUT", { extractionFloor: 0.85 });
  expect(put.status).toBe(200);
  expect(await (await call(alice, "GET")).json()).toEqual({
    extractionFloor: 0.85,
  });
  await call(alice, "PUT", { extractionFloor: 0.5 });
  expect(await (await call(alice, "GET")).json()).toEqual({
    extractionFloor: 0.5,
  });
  expect(await (await call(bob, "GET")).json()).toEqual({
    extractionFloor: 0.7,
  });
});

test.each([1.5, -0.1, "0.8", null])("rejects a floor of %j", async (v) => {
  expect((await call(alice, "PUT", { extractionFloor: v })).status).toBe(400);
});

test("needs a token", async () => {
  expect((await app.request("/api/settings")).status).toBe(401);
});
