import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Access } from "./access.js";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { memories, projects, proposals, sessions } from "./db/schema.js";
import { extractProposals, PROJECTS_SYSTEM, SYSTEM } from "./extract.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let token: string;
let reply = "";
let seen: { system?: string; prompt: string }[] = [];
const providers = fakeProviders();
providers.llm = {
  model: "fake",
  complete: async ({ system, prompt }) => {
    // The dedup check has its own system prompt.
    if (system?.includes("maintain a developer's project memory"))
      return '{"action":"add"}';
    seen.push({ system, prompt });
    return reply;
  },
};

beforeAll(async () => {
  t = await createTestDb();
  app = createApp(t.db, providers);
  token = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as never };
};

const home = { key: "github.com/acme/impression", name: "impression" };
const silk = {
  key: "github.com/acme/silk",
  name: "silk",
  headSha: "def5678",
  edits: 12,
  reads: 2,
  files: ["apps/web/chat.tsx", "packages/db/schema.ts"],
};
const docs = {
  key: "github.com/acme/docs",
  name: "docs",
  headSha: "0123abc",
  edits: 0,
  reads: 3,
  files: ["guide.md"],
};
const ownCandidate = { ...home, headSha: "abc1234", edits: 1, reads: 4 };

// A counter, not Math.random(): the scrubber can redact a long digit run, and two
// redacted transcripts would look like one session sent twice.
let uploads = 0;
const upload = async (candidates?: unknown) => {
  const r = await call("POST", "/sessions", {
    project: home,
    transcript: `session number ${++uploads}`,
    commitSha: "abc1234",
    ...(candidates === undefined ? {} : { candidates }),
  });
  return (r.body as { id: string }).id;
};

const extract = async (id: string, memories: unknown[]) => {
  reply = JSON.stringify({ memories });
  seen = [];
  return (await call("POST", `/sessions/${id}/extract`)).body as Record<
    string,
    number
  >;
};

/** Each accepted proposal of the session: content, project key, anchors. */
const filed = async (sessionId: string) => {
  const rows = await t.db
    .select({ p: proposals, key: projects.key })
    .from(proposals)
    .innerJoin(projects, eq(proposals.projectId, projects.id))
    .where(eq(proposals.sessionId, sessionId));
  const out: Record<string, { key: string; anchors: unknown }> = {};
  for (const r of rows) {
    const mem = r.p.memoryId
      ? await t.db.query.memories.findFirst({
          where: (m, { eq }) => eq(m.id, r.p.memoryId as string),
        })
      : undefined;
    const memKey = mem?.projectId
      ? (
          await t.db.query.projects.findFirst({
            where: (p, { eq }) => eq(p.id, mem.projectId as string),
          })
        )?.key
      : null;
    // The memory must land where its proposal says.
    expect(memKey).toBe(r.key);
    out[r.p.content] = { key: r.key, anchors: r.p.anchors };
  }
  return out;
};

describe("project attribution", () => {
  test("a fact about the other repo goes there, with that repo's HEAD on its anchors", async () => {
    const id = await upload([silk, ownCandidate, docs]);
    const [row] = await t.db.select().from(sessions).where(eq(sessions.id, id));
    // The session itself stays with the project it ran in.
    const [own] = await t.db
      .select()
      .from(projects)
      .where(eq(projects.id, row?.projectId as string));
    expect(own?.key).toBe(home.key);
    expect(row?.candidates).toEqual([
      silk,
      { ...ownCandidate, files: [] },
      docs,
    ]);

    const summary = await extract(id, [
      {
        content: "Chat threads float the composer over the list",
        confidence: 0.9,
        project: silk.key,
        anchors: [
          { path: "apps/web/chat.tsx", symbol: "ChatThread" },
          // A directory holding a touched file.
          { path: "packages/db" },
          // Not a file the session touched in silk.
          { path: "src/extract.ts" },
        ],
      },
      {
        content: "Extraction prompts list every touched repo",
        confidence: 0.9,
        anchors: [{ path: "src/extract.ts" }, { path: "guide.md" }],
      },
    ]);
    expect(summary).toMatchObject({ accepted: 2, skippedNoAccess: 0 });
    expect(seen[0]?.system).toBe(`${SYSTEM}\n${PROJECTS_SYSTEM}`);
    expect(seen[0]?.prompt).toContain(
      `- ${home.key} (the session's own project): 1 edits or commands, 4 reads`,
    );
    expect(seen[0]?.prompt).toContain(
      `- ${silk.key}: 12 edits or commands, 2 reads; files: apps/web/chat.tsx, packages/db/schema.ts`,
    );
    expect(await filed(id)).toEqual({
      "Chat threads float the composer over the list": {
        key: silk.key,
        anchors: [
          {
            path: "apps/web/chat.tsx",
            symbol: "ChatThread",
            commitSha: "def5678",
          },
          { path: "packages/db", commitSha: "def5678" },
        ],
      },
      // The session's own project keeps unknown paths, but not a file docs touched.
      "Extraction prompts list every touched repo": {
        key: home.key,
        anchors: [{ path: "src/extract.ts", commitSha: "abc1234" }],
      },
    });
  });

  test("a pick outside the list falls back to the session's project", async () => {
    const id = await upload([silk]);
    await extract(id, [
      {
        content: "Made-up repo pick",
        confidence: 0.9,
        project: "github.com/evil/elsewhere",
      },
    ]);
    expect((await filed(id))["Made-up repo pick"]?.key).toBe(home.key);
    expect(
      await t.db.query.projects.findFirst({
        where: (p, { eq }) => eq(p.key, "github.com/evil/elsewhere"),
      }),
    ).toBeUndefined();
  });

  test("a practice stays user-scoped whatever project it names", async () => {
    const id = await upload([silk]);
    await extract(id, [
      {
        kind: "practice",
        otherRepos: true,
        content: "Always open a PR instead of pushing to main",
        confidence: 0.9,
        project: silk.key,
      },
    ]);
    const mem = await t.db.query.memories.findFirst({
      where: (m, { eq }) =>
        eq(m.content, "Always open a PR instead of pushing to main"),
    });
    expect(mem).toMatchObject({ scope: "user", projectId: null });
  });

  test("a fact about a repo the person can't reach is dropped", async () => {
    const id = await upload([silk]);
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, id));
    reply = JSON.stringify({
      memories: [
        { content: "Secret repo fact", confidence: 0.9, project: docs.key },
        { content: "Home repo fact", confidence: 0.9, project: home.key },
      ],
    });
    const summary = await extractProposals(t.db, providers, {
      sessionId: id,
      projectId: s?.projectId as string,
      projectKey: home.key,
      owner: "alice",
      commitSha: "abc1234",
      transcript: "t",
      candidates: [silk, docs],
      access: new Access(false, "u1", new Set([home.key, silk.key])),
    });
    expect(summary).toMatchObject({ accepted: 1, skippedNoAccess: 1 });
    expect(Object.keys(await filed(id))).toEqual(["Home repo fact"]);
    expect(
      await t.db.query.projects.findFirst({
        where: (p, { eq }) => eq(p.key, docs.key),
      }),
    ).toBeUndefined();
  });

  test("repeat checks run against the picked project", async () => {
    const content = "Silk feeds are cached for an hour";
    const warm = await upload([silk]);
    await extract(warm, [
      { content: "warm", confidence: 0.9, project: silk.key },
    ]);
    const silkRow = await t.db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.key, silk.key),
    });
    await t.db.insert(memories).values({
      scope: "project",
      projectId: silkRow?.id as string,
      owner: "alice",
      author: "alice",
      agent: "extraction",
      status: "retired",
      content,
      embedding: (await providers.embeddings.embed([content]))[0],
    });
    expect(
      await extract(await upload([silk]), [
        { content, confidence: 0.9, project: silk.key },
      ]),
    ).toMatchObject({ accepted: 0, skippedRepeats: 1 });
    expect(
      await extract(await upload([silk]), [
        { content, confidence: 0.9, project: home.key },
      ]),
    ).toMatchObject({ accepted: 1, skippedRepeats: 0 });
  });

  test("a single-repo session extracts as before", async () => {
    for (const candidates of [undefined, [ownCandidate]]) {
      const id = await upload(candidates);
      await extract(id, [
        {
          content: `Single repo fact ${candidates ? "with" : "without"}`,
          confidence: 0.9,
          project: silk.key,
          anchors: [{ path: "lib/anything.ts" }],
        },
      ]);
      expect(seen[0]?.system).toBe(SYSTEM);
      expect(seen[0]?.prompt).not.toContain("Projects this session touched");
      expect(Object.values(await filed(id))).toEqual([
        {
          key: home.key,
          anchors: [{ path: "lib/anything.ts", commitSha: "abc1234" }],
        },
      ]);
    }
  });

  test("bad or local candidates don't fail the upload and aren't kept", async () => {
    const bad = await upload([{ key: "" }]);
    const local = await upload([{ key: "path:/Users/me/scratch", edits: 3 }]);
    for (const id of [bad, local]) {
      const [s] = await t.db.select().from(sessions).where(eq(sessions.id, id));
      expect(s?.candidates).toBeNull();
    }
  });
});
