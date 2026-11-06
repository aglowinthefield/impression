import type { GithubConfig } from "./config.js";

export interface GithubUser {
  id: number;
  login: string;
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls. */
  interval: number;
  expiresIn: number;
}

/** A GitHub App user token. `refreshToken` and `expiresAt` are null if the app's tokens don't expire. */
export interface GithubTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/** GitHub rejected a token. The person has to sign in again. */
export class GithubAuthError extends Error {}

export type DevicePoll =
  | { status: "ok"; tokens: GithubTokens }
  | { status: "pending" | "slow_down" | "denied" | "expired" };

/** The GitHub calls sign-in needs. Tests replace it with a fake. */
export interface GithubClient {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<GithubTokens>;
  /** Throws GithubAuthError if the refresh token is no longer valid. */
  refresh(refreshToken: string): Promise<GithubTokens>;
  startDevice(): Promise<DeviceStart>;
  pollDevice(deviceCode: string): Promise<DevicePoll>;
  getUser(accessToken: string): Promise<GithubUser>;
  /** Installations of the app that this user can use, with the account each is on. */
  listInstallations(
    accessToken: string,
  ): Promise<{ id: number; account: string }[]>;
  /** `owner/repo` names the user can reach through one installation. */
  listInstallationRepos(
    accessToken: string,
    installationId: number,
  ): Promise<string[]>;
}

const json = { accept: "application/json" };

function parseTokens(r: Record<string, unknown>, now = Date.now()) {
  if (typeof r.access_token !== "string") return null;
  return {
    accessToken: r.access_token,
    refreshToken: typeof r.refresh_token === "string" ? r.refresh_token : null,
    expiresAt:
      typeof r.expires_in === "number"
        ? new Date(now + r.expires_in * 1000)
        : null,
  } satisfies GithubTokens;
}

export function createGithubClient(
  cfg: Pick<GithubConfig, "clientId" | "clientSecret">,
  fetchImpl: typeof fetch = fetch,
): GithubClient {
  const post = async (url: string, body: Record<string, string>) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...json, "content-type": "application/json" },
      body: JSON.stringify({ client_id: cfg.clientId, ...body }),
    });
    if (!res.ok) throw new Error(`GitHub ${url} returned ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const get = async (path: string, accessToken: string) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        ...json,
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "impression",
      },
    });
    if (res.status === 401)
      throw new GithubAuthError(`GitHub ${path} returned 401`);
    if (!res.ok) throw new Error(`GitHub ${path} returned ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  return {
    authorizeUrl(state, redirectUri) {
      const u = new URL("https://github.com/login/oauth/authorize");
      u.searchParams.set("client_id", cfg.clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      return u.toString();
    },
    async exchangeCode(code, redirectUri) {
      const r = await post("https://github.com/login/oauth/access_token", {
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      const tokens = parseTokens(r);
      if (!tokens) {
        throw new Error(`GitHub refused the code: ${String(r.error)}`);
      }
      return tokens;
    },
    async refresh(refreshToken) {
      const r = await post("https://github.com/login/oauth/access_token", {
        client_secret: cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      const tokens = parseTokens(r);
      if (!tokens) {
        throw new GithubAuthError(
          `GitHub refused the refresh: ${String(r.error)}`,
        );
      }
      return tokens;
    },
    async startDevice() {
      const r = await post("https://github.com/login/device/code", {});
      return {
        deviceCode: String(r.device_code),
        userCode: String(r.user_code),
        verificationUri: String(r.verification_uri),
        interval: Number(r.interval ?? 5),
        expiresIn: Number(r.expires_in ?? 900),
      };
    },
    async pollDevice(deviceCode) {
      const r = await post("https://github.com/login/oauth/access_token", {
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const tokens = parseTokens(r);
      if (tokens) return { status: "ok", tokens };
      switch (r.error) {
        case "authorization_pending":
          return { status: "pending" };
        case "slow_down":
          return { status: "slow_down" };
        case "access_denied":
          return { status: "denied" };
        default:
          return { status: "expired" };
      }
    },
    async getUser(accessToken) {
      const r = await get("/user", accessToken);
      return { id: Number(r.id), login: String(r.login) };
    },
    async listInstallations(accessToken) {
      const r = await get("/user/installations?per_page=100", accessToken);
      const items = Array.isArray(r.installations) ? r.installations : [];
      return items.flatMap(
        (i: { id?: number; account?: { login?: string } }) =>
          typeof i.id === "number" && i.account?.login
            ? [{ id: i.id, account: i.account.login }]
            : [],
      );
    },
    async listInstallationRepos(accessToken, installationId) {
      const names: string[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await get(
          `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
          accessToken,
        );
        const repos = Array.isArray(r.repositories) ? r.repositories : [];
        for (const repo of repos as { full_name?: string }[]) {
          if (repo.full_name) names.push(repo.full_name);
        }
        if (repos.length < 100) break;
      }
      return names;
    },
  };
}
