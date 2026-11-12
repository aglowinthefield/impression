import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { DEFAULT_DATABASE_URL } from "./db/client.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

async function reachable(url: string) {
  const sql = postgres(url, { connect_timeout: 2, max: 1, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/**
 * Vitest global setup: make sure the test Postgres is up. CI provides it as a service;
 * locally this starts the compose `postgres` service. The fixed project name means every
 * worktree shares one container instead of fighting over port 54329.
 */
export default async function setup() {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  if (await reachable(url)) return;
  if (process.env.DATABASE_URL) {
    throw new Error(`Postgres at DATABASE_URL is not reachable: ${url}`);
  }
  try {
    execFileSync(
      "docker",
      [
        "compose",
        "-p",
        "impression",
        "-f",
        join(repoRoot, "docker-compose.yml"),
        "up",
        "-d",
        "--wait",
        "postgres",
      ],
      { stdio: "inherit" },
    );
  } catch {
    throw new Error(
      "API tests need Postgres on localhost:54329 and `docker compose up -d postgres` failed. Start Docker (or set DATABASE_URL) and rerun.",
    );
  }
}
