import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export async function runMigrations(url: string) {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await close();
  }
}
