import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { type GithubConfig, loadConfig } from "./config.js";
import { apiTokens, users } from "./db/schema.js";
import type { DevicePoll, GithubClient } from "./github.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

const cfg: GithubConfig = {
  clientId: "cid",
  clientSecret: "secret",
  allowedAccounts: ["acme", "solo"],
  appSlug: "impression-app",
  publicUrl: null,
};

/** Access tokens map to a GitHub user and the accounts that installed the app for them. */
const people: Record<
  string,
  { id: number; login: string; installs: string[] }
> = {
  "tok-sam": { id: 1, login: "sam", installs: ["Acme"] },
  "tok-solo": { id: 2, login: "solo", installs: ["solo"] },
  "tok-new": { id: 3, login: "solo", installs: [] },
  "tok-out": { id: 4, login: "mallory", installs: ["mallory"] },
};

const tokens = (accessToken: string) => ({
  accessToken,
  refreshToken: null,
  expiresAt: null,
});

let devicePoll: DevicePoll = { status: "pending" };
const github: GithubClient = {
  authorizeUrl: (state, redirect) =>
    `https://github.test/authorize?state=${state}&redirect=${encodeURIComponent(redirect)}`,
  exchangeCode: async (code) => {
    if (!(code in people)) throw new Error("bad code");
    return { accessToken: code, refreshToken: null, expiresAt: null };
  },
  refresh: async () => {
    throw new Error("not used");
  },
  startDevice: async () => ({
    deviceCode: "dev1",
    userCode: "ABCD-1234",
    verificationUri: "https://github.test/device",
    interval: 5,
    expiresIn: 900,
  }),
  pollDevice: async () => devicePoll,
  getUser: async (t) => people[t] as { id: number; login: string },
  listInstallations: async (t) =>
    (people[t]?.installs ?? []).map((account, id) => ({ id, account })),
  listInstallationRepos: async () => [],
};

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestDb();
  app = createApp(t.db, fakeProviders(), { github: cfg, githubClient: github });
});
afterAll(() => t.drop());

/** Runs the browser flow and returns the callback response. */
async function callback(
  code: string,
  state = "s1",
  cookie = "imp_oauth_state=s1",
) {
  return app.request(`/auth/github/callback?code=${code}&state=${state}`, {
    headers: { cookie },
  });
}

const tokenFrom = (res: Response) =>
  decodeURIComponent(
    (res.headers.get("location") ?? "").split("#token=")[1] ?? "",
  );

describe("browser flow", () => {
  test("redirects to GitHub with a state cookie", async () => {
    const res = await app.request("http://impression.test/auth/github");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") as string);
    const state = loc.searchParams.get("state");
    expect(res.headers.get("set-cookie")).toContain(`imp_oauth_state=${state}`);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(loc.searchParams.get("redirect")).toBe(
      "http://impression.test/auth/github/callback",
    );
  });

  test("signs in an allowlisted org member and the token works", async () => {
    const res = await callback("tok-sam");
    expect(res.status).toBe(302);
    const token = tokenFrom(res);
    expect(token).toMatch(/^imp_/);
    const who = await app.request("/api/whoami", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await who.json()).toEqual({ name: "sam" });
  });

  test("a second sign-in revokes the previous browser token", async () => {
    const first = tokenFrom(await callback("tok-solo"));
    const second = tokenFrom(await callback("tok-solo"));
    const check = (tok: string) =>
      app.request("/api/whoami", {
        headers: { authorization: `Bearer ${tok}` },
      });
    expect((await check(first)).status).toBe(401);
    expect((await check(second)).status).toBe(200);
    const [user] = await t.db.select().from(users).where(eq(users.githubId, 2));
    const live = await t.db
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, user?.id as string),
          isNull(apiTokens.revokedAt),
        ),
      );
    expect(live).toHaveLength(1);
  });

  test("refuses someone whose installs aren't on the allowlist", async () => {
    const res = await callback("tok-out");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("allowlist");
    expect(
      await t.db.select().from(users).where(eq(users.githubId, 4)),
    ).toHaveLength(0);
  });

  test("points an allowlisted user with no install at the install page", async () => {
    const res = await callback("tok-new");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(
      "https://github.com/apps/impression-app/installations/new",
    );
  });

  test("rejects a callback whose state doesn't match the cookie", async () => {
    expect((await callback("tok-sam", "other")).status).toBe(400);
    expect((await callback("tok-sam", "s1", "")).status).toBe(400);
  });

  test("reports a GitHub failure without leaking details", async () => {
    const res = await callback("bad-code");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("bad code");
  });
});

describe("device flow", () => {
  const poll = () =>
    app.request("/auth/github/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: "dev1" }),
    });

  test("starts a device login", async () => {
    const res = await app.request("/auth/github/device", { method: "POST" });
    expect(await res.json()).toMatchObject({
      deviceCode: "dev1",
      userCode: "ABCD-1234",
    });
  });

  test("answers 202 while the user hasn't approved", async () => {
    devicePoll = { status: "pending" };
    const res = await poll();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  test("mints a CLI token on approval and keeps earlier CLI tokens", async () => {
    devicePoll = { status: "ok", tokens: tokens("tok-sam") };
    const a = (await (await poll()).json()) as { token: string; name: string };
    const b = (await (await poll()).json()) as { token: string };
    expect(a.name).toBe("sam");
    for (const tok of [a.token, b.token]) {
      const res = await app.request("/api/whoami", {
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(res.status).toBe(200);
    }
  });

  test("refuses a user who isn't allowed", async () => {
    devicePoll = { status: "ok", tokens: tokens("tok-out") };
    expect((await poll()).status).toBe(403);
  });

  test("refuses when the user denied or the code expired", async () => {
    devicePoll = { status: "denied" };
    expect((await poll()).status).toBe(403);
  });

  test("requires a deviceCode", async () => {
    const res = await app.request("/auth/github/device/poll", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});

describe("config and wiring", () => {
  test("/auth/config reports whether GitHub sign-in is on", async () => {
    expect(await (await app.request("/auth/config")).json()).toEqual({
      github: true,
    });
    const off = createApp(t.db, fakeProviders());
    expect(await (await off.request("/auth/config")).json()).toEqual({
      github: false,
    });
    expect((await off.request("/auth/github")).status).toBe(404);
  });

  test("loadConfig parses the allowlist and requires both secrets", () => {
    const base = { GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" };
    expect(loadConfig({}).github).toBeNull();
    expect(
      loadConfig({ ...base, GITHUB_ALLOWED_ACCOUNTS: " Acme, Sam ,," }).github
        ?.allowedAccounts,
    ).toEqual(["acme", "sam"]);
    expect(() => loadConfig({ GITHUB_CLIENT_ID: "a" })).toThrow(/together/);
    expect(() => loadConfig(base)).toThrow(/ALLOWED_ACCOUNTS/);
  });
});
