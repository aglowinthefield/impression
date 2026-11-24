import { expect, test } from "vitest";
import type { Config } from "./config.js";
import { createSavedClient } from "./saved-client.js";

/** A server that accepts only `imp_new`, and a config file the test can rewrite. */
function setup(initial: Config) {
  let saved = initial;
  const tokens: (string | null)[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization");
    tokens.push(auth);
    return auth === "Bearer imp_new"
      ? new Response('{"name":"tom"}', { status: 200 })
      : new Response('{"error":"invalid token"}', { status: 401 });
  }) as unknown as typeof fetch;
  const client = createSavedClient("mcp", fetchImpl, () => saved);
  return {
    client,
    tokens,
    relogin: (token: string) => {
      saved = { ...saved, token };
    },
  };
}

test("a login saved after startup is picked up on the next 401", async () => {
  const s = setup({ url: "http://h", token: "imp_old" });
  await expect(s.client.get("/whoami")).rejects.toThrow("Impression API 401");
  s.relogin("imp_new");
  await expect(s.client.get("/whoami")).resolves.toEqual({ name: "tom" });
  expect(s.tokens).toEqual([
    "Bearer imp_old",
    "Bearer imp_old",
    "Bearer imp_new",
  ]);
  // Later calls go straight to the new token.
  await s.client.get("/whoami");
  expect(s.tokens.at(-1)).toBe("Bearer imp_new");
});

test("an unchanged config surfaces the 401 without a retry", async () => {
  const s = setup({ url: "http://h", token: "imp_old" });
  await expect(s.client.post("/search", {})).rejects.toThrow(
    "Run `impression login` to sign in again.",
  );
  expect(s.tokens).toEqual(["Bearer imp_old"]);
});

test("starting signed out works once a login is saved", async () => {
  const s = setup({ url: "http://h" });
  await expect(s.client.get("/whoami")).rejects.toThrow(
    "Not signed in. Run: impression login",
  );
  s.relogin("imp_new");
  await expect(s.client.get("/whoami")).resolves.toEqual({ name: "tom" });
});
