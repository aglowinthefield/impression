import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let token: string;
beforeAll(async () => {
  t = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), "imp-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>app</html>");
  writeFileSync(join(dir, "assets", "a.js"), "console.log(1)");
  app = createApp(t.db, fakeProviders(), { webDir: dir });
  token = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

test("serves the UI, assets and index.html for client routes", async () => {
  expect(await (await app.request("/")).text()).toBe("<html>app</html>");
  expect(await (await app.request("/assets/a.js")).text()).toBe(
    "console.log(1)",
  );
  expect(await (await app.request("/memories/some-route")).text()).toBe(
    "<html>app</html>",
  );
});

test("API and health still win over the UI", async () => {
  expect(await (await app.request("/health")).json()).toEqual({ ok: true });
  expect((await app.request("/api/projects")).status).toBe(401);
});

test("GET /api/projects lists projects by name", async () => {
  for (const key of ["github.com/a/zed", "github.com/a/alpha"]) {
    await app.request("/api/memories", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: "project",
        project: { key },
        content: `note for ${key}`,
        dedup: false,
      }),
    });
  }
  const res = await app.request("/api/projects", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await res.json()).toEqual({
    items: [
      { key: "github.com/a/alpha", name: "alpha" },
      { key: "github.com/a/zed", name: "zed" },
    ],
  });
});
