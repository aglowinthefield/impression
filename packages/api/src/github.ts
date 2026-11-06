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

export type DevicePoll =
  | { status: "ok"; accessToken: string }
  | { status: "pending" | "slow_down" | "denied" | "expired" };

/** The GitHub calls sign-in needs. Tests replace it with a fake. */
export interface GithubClient {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  startDevice(): Promise<DeviceStart>;
  pollDevice(deviceCode: string): Promise<DevicePoll>;
  getUser(accessToken: string): Promise<GithubUser>;
  /** Logins of the accounts that installed the app where this user can use it. */
  listInstallationAccounts(accessToken: string): Promise<string[]>;
}

const json = { accept: "application/json" };

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
      if (typeof r.access_token !== "string") {
        throw new Error(`GitHub refused the code: ${String(r.error)}`);
      }
      return r.access_token;
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
      if (typeof r.access_token === "string") {
        return { status: "ok", accessToken: r.access_token };
      }
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
    async listInstallationAccounts(accessToken) {
      const r = await get("/user/installations?per_page=100", accessToken);
      const items = Array.isArray(r.installations) ? r.installations : [];
      return items.flatMap((i: { account?: { login?: string } }) =>
        i.account?.login ? [i.account.login] : [],
      );
    },
  };
}
