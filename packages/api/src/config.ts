import { DEFAULT_DATABASE_URL } from "./db/client.js";

export interface Config {
  port: number;
  databaseUrl: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `PORT must be an integer from 0 to 65535, got "${env.PORT}"`,
    );
  }
  return { port, databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL };
}
