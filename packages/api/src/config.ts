import { DEFAULT_DATABASE_URL } from "./db/client.js";

export interface Config {
  port: number;
  databaseUrl: string;
  /** Proposals at or above this confidence are accepted without review. Null disables. */
  autoAcceptConfidence: number | null;
  /** Null when GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET aren't both set. */
  github: GithubConfig | null;
}

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** Lowercased logins of the users and orgs whose app installations let someone sign in. */
  allowedAccounts: string[];
  /** The app's slug, for the install link shown to people who haven't installed it. */
  appSlug: string | null;
  /** Public origin, for the OAuth callback. Falls back to the request's origin. */
  publicUrl: string | null;
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
    github: loadGithubConfig(env),
  };
}

function loadGithubConfig(
  env: Record<string, string | undefined>,
): GithubConfig | null {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together",
    );
  }
  const allowedAccounts = (env.GITHUB_ALLOWED_ACCOUNTS ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (allowedAccounts.length === 0) {
    throw new Error(
      "GITHUB_ALLOWED_ACCOUNTS must list at least one GitHub user or org when GitHub sign-in is on",
    );
  }
  return {
    clientId,
    clientSecret,
    allowedAccounts,
    appSlug: env.GITHUB_APP_SLUG || null,
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, "") || null,
  };
}
