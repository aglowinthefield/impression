export interface ApiClient {
  post(path: string, body: unknown): Promise<unknown>;
}

/** Minimal HTTP client for the Impression API. */
export function createClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    async post(path, body) {
      const res = await fetchImpl(`${root}/api${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
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
    },
  };
}
