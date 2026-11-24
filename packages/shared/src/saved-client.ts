import { createClient, type FullApiClient } from "./client.js";
import { type Config, loadConfig } from "./config.js";

/**
 * A client for long-lived callers (the MCP server, the pi extension) that signs
 * requests with the saved sign-in. After a 401 it re-reads the config, and if
 * `impression login` has saved a new token since, retries once with it, so a
 * re-login takes effect without restarting the agent.
 */
export function createSavedClient(
  client: string,
  fetchImpl: typeof fetch = fetch,
  load: () => Config = loadConfig,
): FullApiClient {
  let config = load();
  const current = () => {
    if (!config.token) throw new Error("Not signed in. Run: impression login");
    return createClient(config.url, config.token, fetchImpl, client);
  };
  const send =
    <A extends unknown[]>(
      call: (c: FullApiClient, ...args: A) => Promise<unknown>,
    ) =>
    async (...args: A) => {
      const before = config;
      try {
        return await call(current(), ...args);
      } catch (e) {
        const refused =
          /^Impression API 401\b/.test((e as Error).message) || !before.token;
        if (!refused) throw e;
        config = load();
        if (config.token === before.token && config.url === before.url) throw e;
        return call(current(), ...args);
      }
    };
  return {
    get: send((c, path: string) => c.get(path)),
    post: send((c, path: string, body: unknown) => c.post(path, body)),
    patch: send((c, path: string, body: unknown) => c.patch(path, body)),
    put: send((c, path: string, body: unknown) => c.put(path, body)),
    delete: send((c, path: string) => c.delete(path)),
  };
}
