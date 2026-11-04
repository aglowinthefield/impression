import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createDb, DEFAULT_DATABASE_URL } from "./client.js";
import { runMigrations } from "./migrate.js";
import { anchors, EMBEDDING_DIM, memories, projects } from "./schema.js";

const adminUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const dbName = `impression_test_${randomUUID().replaceAll("-", "")}`;
const testUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

let ctx: ReturnType<typeof createDb>;

beforeAll(async () => {
  const admin = postgres(adminUrl);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  await runMigrations(testUrl);
  ctx = createDb(testUrl);
});

afterAll(async () => {
  await ctx.close();
  const admin = postgres(adminUrl);
  await admin.unsafe(`DROP DATABASE ${dbName}`);
  await admin.end();
});

function vec(first: number) {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = first;
  v[1] = 1;
  return v;
}

test("migrations create the pgvector extension and tables", async () => {
  const ext =
    await ctx.sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
  expect(ext).toHaveLength(1);
  const tables = await ctx.sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name`;
  expect(tables.map((t) => t.table_name)).toEqual(
    expect.arrayContaining([
      "anchors",
      "memories",
      "projects",
      "proposals",
      "sessions",
    ]),
  );
});

test("stores a memory with provenance, anchors and an embedding, and finds it by vector and full text", async () => {
  const { db } = ctx;
  const [project] = await db
    .insert(projects)
    .values({ key: "github.com/acme/app", name: "app" })
    .returning();
  const [near] = await db
    .insert(memories)
    .values({
      scope: "project",
      projectId: project!.id,
      owner: "me",
      content: "Migrations run via make db-migrate",
      embedding: vec(0.9),
      embeddingModel: "text-embedding-3-small",
      embeddingDim: EMBEDDING_DIM,
      author: "me",
      agent: "pi",
    })
    .returning();
  await db.insert(memories).values({
    scope: "project",
    projectId: project!.id,
    owner: "me",
    content: "Auth lives in src/auth.ts",
    embedding: vec(-0.9),
    embeddingModel: "text-embedding-3-small",
    embeddingDim: EMBEDDING_DIM,
    author: "me",
  });
  await db
    .insert(anchors)
    .values({ memoryId: near!.id, path: "Makefile", commitSha: "abc123" });

  const query = JSON.stringify(vec(0.9));
  const byVector = await db
    .select({ id: memories.id })
    .from(memories)
    .orderBy(sql`embedding <=> ${query}::vector`)
    .limit(1);
  expect(byVector[0]?.id).toBe(near!.id);

  const byText = await db
    .select({ id: memories.id })
    .from(memories)
    .where(sql`search @@ websearch_to_tsquery('english', 'migrations')`);
  expect(byText.map((r) => r.id)).toEqual([near!.id]);

  const [row] = await db
    .select()
    .from(memories)
    .where(eq(memories.id, near!.id));
  expect(row).toMatchObject({ status: "active", pinned: false, agent: "pi" });
});

test("a superseded memory keeps its row and points at its replacement", async () => {
  const { db } = ctx;
  const [oldM] = await db
    .insert(memories)
    .values({
      scope: "user",
      owner: "me",
      content: "I prefer npm",
      author: "me",
    })
    .returning();
  const [newM] = await db
    .insert(memories)
    .values({
      scope: "user",
      owner: "me",
      content: "I prefer pnpm",
      author: "me",
    })
    .returning();
  await db
    .update(memories)
    .set({ status: "superseded", supersededBy: newM!.id })
    .where(eq(memories.id, oldM!.id));
  const [row] = await db
    .select()
    .from(memories)
    .where(eq(memories.id, oldM!.id));
  expect(row).toMatchObject({ status: "superseded", supersededBy: newM!.id });
});

test("deleting a project removes its memories and anchors", async () => {
  const { db } = ctx;
  const [p] = await db
    .insert(projects)
    .values({ key: "github.com/acme/other", name: "other" })
    .returning();
  const [m] = await db
    .insert(memories)
    .values({
      scope: "project",
      projectId: p!.id,
      owner: "me",
      content: "x",
      author: "me",
    })
    .returning();
  await db
    .insert(anchors)
    .values({ memoryId: m!.id, path: "a.ts", commitSha: "def" });
  await db.delete(projects).where(eq(projects.id, p!.id));
  expect(
    await db.select().from(memories).where(eq(memories.id, m!.id)),
  ).toHaveLength(0);
  expect(
    await db.select().from(anchors).where(eq(anchors.memoryId, m!.id)),
  ).toHaveLength(0);
});
