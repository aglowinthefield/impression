import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDb, DEFAULT_DATABASE_URL } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";

/** Creates a throwaway migrated database for a test file. Call `drop` in afterAll. */
export async function createTestDb() {
  const adminUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const dbName = `impression_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const admin = postgres(adminUrl);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  await admin.end();
  await runMigrations(url.toString());
  const ctx = createDb(url.toString());
  return {
    ...ctx,
    async drop() {
      await ctx.close();
      const a = postgres(adminUrl);
      await a.unsafe(`DROP DATABASE ${dbName}`);
      await a.end();
    },
  };
}
