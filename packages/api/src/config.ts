import { DEFAULT_DATABASE_URL } from "./db/client.js";

export interface Config {
  port: number;
  databaseUrl: string;
  /** Proposals at or above this confidence are accepted without review. Null disables. */
  autoAcceptConfidence: number | null;
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
  const raw = env.AUTO_ACCEPT_CONFIDENCE;
  let autoAcceptConfidence: number | null = 0.9;
  if (raw !== undefined && raw !== "") {
    if (raw === "off") autoAcceptConfidence = null;
    else {
      autoAcceptConfidence = Number(raw);
      if (!(autoAcceptConfidence >= 0 && autoAcceptConfidence <= 1)) {
        throw new Error(
          `AUTO_ACCEPT_CONFIDENCE must be 0 to 1 or "off", got "${raw}"`,
        );
      }
    }
  }
  return {
    port,
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    autoAcceptConfidence,
  };
}
