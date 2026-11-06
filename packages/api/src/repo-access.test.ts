import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import type { GithubConfig } from "./config.js";
import { memories, sessions, users } from "./db/schema.js";
import { GithubAuthError, type GithubClient } from "./github.js";
import { renameOwner } from "./owner-rename.js";
import { RepoAccess } from "./repo-access.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";
import { tokenCipher } from "./token-cipher.js";

const cfg: GithubConfig = {
  clientId: "cid",
  clientSecret: "secret",
  allowedAccounts: ["acme", "kim"],
  appSlug: null,
  publicUrl: null,
};

type Install = { id: number; account: string; repos: string[] };
/** What GitHub says each access token can reach. Tests change it to simulate revocation. */
const world: Record<
  string,
  { id: number; login: string; installs: Install[] }
> = {
  "tok-sam": {
    id: 1,
    login: "sam",
    installs: [{ id: 10, account: "acme", repos: ["acme/app", "acme/secret"] }],
  },
  "tok-kim": {
    id: 2,
    login: "kim",
    installs: [
      { id: 10, account: "acme", repos: ["acme/app"] },
      { id: 11, account: "kim", repos: ["kim/own"] },
    ],
  },
  "tok-taken": {
    id: 3,
    login: "Legacy",
    installs: [{ id: 10, account: "acme", repos: [] }],
  },
};
let refreshFails = false;
let githubCalls = 0;

const github: GithubClient = {
  authorizeUrl: () => "",
  exchangeCode: async (code) => ({
    accessToken: code,
    refreshToken: `refresh-${code}`,
    expiresAt: new Date(Date.now() + 3600_000),
  }),
  refresh: async (r) => {
    if (refreshFails) throw new GithubAuthError("revoked");
    const code = r.replace("refresh-", "");
    return {
      accessToken: code,
      refreshToken: r,
      expiresAt: new Date(Date.now() + 3600_000),
    };
  },
  startDevice: async () => {
    throw new Error("unused");
  },
  pollDevice: async () => ({ status: "pending" }),
  getUser: async (t) => world[t] as { id: number; login: string },
  listInstallations: async (t) => {
    githubCalls++;
    return (world[t]?.installs ?? []).map(({ id, account }) => ({
      id,
      account,
    }));
  },
  listInstallationRepos: async (t, id) =>
    world[t]?.installs.find((i) => i.id === id)?.repos ?? [],
};

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let sam: string;
let kim: string;
let admin: string;

const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signIn(code: string) {
  const res = await app.request(`/auth/github/callback?code=${code}&state=s`, {
    headers: { cookie: "imp_oauth_state=s" },
  });
  return decodeURIComponent(
    (res.headers.get("location") ?? "").split("#token=")[1] ?? "",
  );
}

const secret = { key: "github.com/acme/secret" };
const shared = { key: "github.com/acme/app" };

beforeAll(async () => {
  t = await createTestDb();
  // ttl 0: every request asks GitHub, so revocation shows up immediately.
  app = createApp(t.db, fakeProviders(), {
    github: cfg,
    githubClient: github,
    repoAccess: new RepoAccess(t.db, github, cfg, { ttlMs: 0 }),
  });
  sam = await signIn("tok-sam");
  kim = await signIn("tok-kim");
  admin = await createToken(t.db, "ops");
});
afterAll(() => t.drop());

describe("repo access", () => {
  test("projects list only the repos a person can reach, admin tokens see all", async () => {
    await call(sam, "POST", "/memories", {
      scope: "project",
      project: secret,
      content: "secret thing",
    });
    const names = async (tok: string) =>
      (
        (await (await call(tok, "GET", "/projects")).json()) as {
          items: { key: string }[];
        }
      ).items.map((p) => p.key);
    expect(await names(sam)).toContain("github.com/acme/secret");
    expect(await names(kim)).not.toContain("github.com/acme/secret");
    expect(await names(admin)).toContain("github.com/acme/secret");
  });

  test("a project you can't reach is a 404, not a 403", async () => {
    const make = await call(kim, "POST", "/memories", {
      scope: "project",
      project: secret,
      content: "probe",
    });
    expect(make.status).toBe(404);
    expect(
      (await call(kim, "GET", "/memories?project=github.com/acme/secret"))
        .status,
    ).toBe(200);
    const list = (await (
      await call(kim, "GET", "/memories?project=github.com/acme/secret")
    ).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
    expect(
      (
        await call(kim, "POST", "/sessions", {
          project: secret,
          transcript: "x",
        })
      ).status,
    ).toBe(404);
  });

  test("repo names match case-insensitively", async () => {
    const res = await call(kim, "POST", "/memories", {
      scope: "project",
      project: { key: "github.com/Acme/App" },
      content: "case check",
    });
    expect(res.status).toBe(201);
  });

  test("team memories reach everyone on the repo and vanish when access does", async () => {
    const m = (await (
      await call(sam, "POST", "/memories", {
        scope: "project",
        project: shared,
        content: "team note",
      })
    ).json()) as { id: string };
    expect((await call(kim, "GET", `/memories/${m.id}`)).status).toBe(404);
    await call(sam, "PATCH", `/memories/${m.id}`, { scope: "team" });
    expect((await call(kim, "GET", `/memories/${m.id}`)).status).toBe(200);
    const found = (await (
      await call(kim, "POST", "/search", {
        query: "team note",
        project: shared.key,
      })
    ).json()) as { results: { id: string }[] };
    expect(found.results.map((r) => r.id)).toContain(m.id);

    const kimApp = world["tok-kim"]?.installs[0] as Install;
    const original = kimApp.repos;
    kimApp.repos = [];
    expect((await call(kim, "GET", `/memories/${m.id}`)).status).toBe(404);
    const core = (await (
      await call(kim, "GET", `/core?project=${shared.key}`)
    ).json()) as { items: unknown[] };
    expect(core.items).toEqual([]);
    kimApp.repos = original;
  });

  test("team memories in a repo you can't reach stay hidden", async () => {
    // Sam keeps access to acme/secret, so a team memory there is invisible to Kim.
    const m = (await (
      await call(sam, "POST", "/memories", {
        scope: "project",
        project: secret,
        content: "secret team note",
      })
    ).json()) as { id: string };
    await call(sam, "PATCH", `/memories/${m.id}`, { scope: "team" });
    expect((await call(kim, "GET", `/memories/${m.id}`)).status).toBe(404);
  });

  test("path: projects belong to their creator", async () => {
    const p = { key: "path:/home/sam/scratch" };
    expect(
      (
        await call(sam, "POST", "/memories", {
          scope: "project",
          project: p,
          content: "local",
        })
      ).status,
    ).toBe(201);
    const keys = async (tok: string) =>
      (
        (await (await call(tok, "GET", "/projects")).json()) as {
          items: { key: string }[];
        }
      ).items.map((x) => x.key);
    expect(await keys(sam)).toContain(p.key);
    expect(await keys(kim)).not.toContain(p.key);
    expect(
      (
        await call(kim, "POST", "/memories", {
          scope: "project",
          project: p,
          content: "hijack",
        })
      ).status,
    ).toBe(404);
  });

  test("sessions and proposals follow project access", async () => {
    const s = await call(sam, "POST", "/sessions", {
      project: secret,
      transcript: "hello",
    });
    expect(s.status).toBe(201);
    const { id } = (await s.json()) as { id: string };
    expect((await call(sam, "GET", `/sessions/${id}`)).status).toBe(200);
    // Sam loses the repo: his own session is no longer reachable.
    const inst = world["tok-sam"]?.installs[0] as Install;
    const original = inst.repos;
    inst.repos = ["acme/app"];
    expect((await call(sam, "GET", `/sessions/${id}`)).status).toBe(404);
    expect(
      (await call(sam, "POST", `/sessions/${id}/extract`, {})).status,
    ).toBe(404);
    inst.repos = original;
    expect(
      await t.db.select().from(sessions).where(eq(sessions.id, id)),
    ).toHaveLength(1);
  });

  test("manual tokens keep seeing everything and own their data", async () => {
    const list = (await (
      await call(admin, "GET", "/memories?scope=project")
    ).json()) as {
      items: unknown[];
    };
    // Admin sees project projects but not other people's private memories.
    expect(list.items).toEqual([]);
    const res = await call(admin, "POST", "/memories", {
      scope: "project",
      project: secret,
      content: "ops note",
    });
    expect(res.status).toBe(201);
  });
});

describe("GitHub session", () => {
  test("asks to sign in again when GitHub revoked the session", async () => {
    const tok = await signIn("tok-sam");
    await t.db
      .update(users)
      .set({ accessExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(users.githubId, 1));
    refreshFails = true;
    const res = await call(tok, "GET", "/memories");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /sign in again/,
    );
    refreshFails = false;
    // The stored tokens are gone, so even a working GitHub can't revive them.
    expect((await call(tok, "GET", "/memories")).status).toBe(401);
    sam = await signIn("tok-sam");
    expect((await call(sam, "GET", "/memories")).status).toBe(200);
  });

  test("refreshes an expiring token and keeps working", async () => {
    await t.db
      .update(users)
      .set({ accessExpiresAt: new Date(Date.now() + 5000) })
      .where(eq(users.githubId, 1));
    expect((await call(sam, "GET", "/memories")).status).toBe(200);
    const [u] = await t.db.select().from(users).where(eq(users.githubId, 1));
    expect((u?.accessExpiresAt?.getTime() ?? 0) > Date.now() + 60_000).toBe(
      true,
    );
  });

  test("drops someone who is no longer on an allowlisted installation", async () => {
    const inst = world["tok-kim"]?.installs as Install[];
    const original = [...inst];
    world["tok-kim"]?.installs.splice(0, 2, {
      id: 99,
      account: "other",
      repos: ["other/x"],
    });
    expect((await call(kim, "GET", "/memories")).status).toBe(401);
    world["tok-kim"]?.installs.splice(0, 1, ...original);
  });

  test("stores GitHub tokens sealed, not in plain text", async () => {
    const [u] = await t.db.select().from(users).where(eq(users.githubId, 2));
    expect(u?.accessTokenEnc).toBeTruthy();
    expect(u?.accessTokenEnc).not.toContain("tok-kim");
    expect(tokenCipher("secret").open(u?.accessTokenEnc ?? null)).toBe(
      "tok-kim",
    );
    expect(tokenCipher("other").open(u?.accessTokenEnc ?? null)).toBeNull();
  });
});

describe("RepoAccess cache", () => {
  test("serves from cache within the ttl and falls back to it when GitHub fails", async () => {
    let now = 1_000_000;
    const ra = new RepoAccess(t.db, github, cfg, {
      ttlMs: 1000,
      now: () => now,
    });
    const [u] = await t.db.select().from(users).where(eq(users.githubId, 2));
    const id = u?.id as string;
    githubCalls = 0;
    const first = await ra.reposFor(id);
    expect(first.has("github.com/kim/own")).toBe(true);
    const calls = githubCalls;
    await ra.reposFor(id);
    expect(githubCalls).toBe(calls);
    now += 5000;
    const broken = {
      ...github,
      listInstallations: async () => {
        throw new Error("github down");
      },
    };
    const ra2 = new RepoAccess(t.db, broken, cfg, {
      ttlMs: 1000,
      now: () => now,
    });
    await expect(ra2.reposFor(id)).rejects.toThrow("github down");
    const stale = new RepoAccess(t.db, github, cfg, {
      ttlMs: 1000,
      now: () => now,
    });
    await stale.reposFor(id);
    (stale as unknown as { github: GithubClient }).github = broken;
    now += 5000;
    expect((await stale.reposFor(id)).has("github.com/kim/own")).toBe(true);
  });
});

describe("sign-in name clash", () => {
  test("refuses a GitHub login that matches a manual token's name", async () => {
    await createToken(t.db, "legacy");
    const res = await app.request(
      `/auth/github/callback?code=tok-taken&state=s`,
      { headers: { cookie: "imp_oauth_state=s" } },
    );
    expect(res.headers.get("location") ?? "").not.toContain("#token=");
  });
});

describe("owner:rename", () => {
  test("moves memories, authorship and sessions to the new name", async () => {
    const old = await createToken(t.db, "oldname");
    await call(old, "POST", "/memories", { scope: "user", content: "mine" });
    const moved = await renameOwner(t.db, "oldname", "newname");
    expect(moved.memories).toBeGreaterThanOrEqual(1);
    const rows = await t.db
      .select()
      .from(memories)
      .where(eq(memories.owner, "newname"));
    expect(rows.every((r) => r.author === "newname")).toBe(true);
    expect(rows.map((r) => r.content)).toContain("mine");
  });
});
