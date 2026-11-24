import { hostname } from "node:os";

export interface ApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** Adds the write verbs the review commands need. */
export interface FullApiClient extends ApiClient {
  patch(path: string, body: unknown): Promise<unknown>;
  put(path: string, body: unknown): Promise<unknown>;
  delete(path: string): Promise<unknown>;
}

declare const __IMPRESSION_VERSION__: string | undefined;

/**
 * Names the client and machine behind a request, e.g. `pi/0.3.0 (tom-mini)`, so a
 * token's owner can see where it is used. `IMPRESSION_MACHINE` overrides the hostname.
 */
export function clientName(name: string, env = process.env): string {
  const version =
    typeof __IMPRESSION_VERSION__ === "string" ? __IMPRESSION_VERSION__ : "dev";
  const machine = env.IMPRESSION_MACHINE?.trim() || hostname();
  return `${name}/${version} (${machine})`;
}

/** Minimal HTTP client for the Impression API. `client` names the caller, see `clientName`. */
export function createClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  client = "cli",
): FullApiClient {
  const root = baseUrl.replace(/\/+$/, "");
  const from = clientName(client);
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${root}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-impression-client": from,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const msg =
        json && typeof json === "object" && "error" in json
          ? String((json as { error: unknown }).error)
          : text.slice(0, 200);
      // Every client (CLI, MCP, pi) shows this, so a refused token says how to recover.
      const fix =
        res.status === 401 ? ". Run `impression login` to sign in again." : "";
      throw new Error(`Impression API ${res.status}: ${msg}${fix}`);
    }
    return json;
  };
  return {
    get: (path) => send("GET", path),
    post: (path, body) => send("POST", path, body),
    patch: (path, body) => send("PATCH", path, body),
    put: (path, body) => send("PUT", path, body),
    delete: (path) => send("DELETE", path),
  };
}
