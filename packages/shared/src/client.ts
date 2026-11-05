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

/** Minimal HTTP client for the Impression API. */
export function createClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): FullApiClient {
  const root = baseUrl.replace(/\/+$/, "");
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${root}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
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
      throw new Error(`Impression API ${res.status}: ${msg}`);
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
