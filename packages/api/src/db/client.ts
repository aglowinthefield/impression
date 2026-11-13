import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export const DEFAULT_DATABASE_URL =
  "postgres://impression:impression@localhost:54329/impression";

export function createDb(url: string) {
  const sql = postgres(url, { onnotice: () => {} });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, sql, close: () => sql.end() };
}

export type Db = ReturnType<typeof createDb>["db"];

/** A transaction, as passed to `db.transaction`'s callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either the database or a transaction on it, for helpers that run inside both. */
export type Queryer = Db | Tx;
