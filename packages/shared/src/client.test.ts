import { hostname } from "node:os";
import { describe, expect, test } from "vitest";
import { clientName, createClient } from "./client.js";

describe("createClient", () => {
  test("sends the bearer token and surfaces API errors", async () => {
    let seen: Request | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = new Request(url, init);
      return new Response('{"error":"nope"}', { status: 422 });
    }) as unknown as typeof fetch;
    const c = createClient("http://h:3000/", "imp_x", fetchImpl);
    await expect(c.post("/memories", {})).rejects.toThrow(
      "Impression API 422: nope",
    );
    expect(seen?.url).toBe("http://h:3000/api/memories");
    expect(seen?.headers.get("authorization")).toBe("Bearer imp_x");
    expect(seen?.headers.get("x-impression-client")).toBe(
      `cli/dev (${hostname()})`,
    );
    await expect(c.get("/core")).rejects.toThrow("422");
    expect(seen?.method).toBe("GET");
    expect(seen?.url).toBe("http://h:3000/api/core");
  });
});

test("a refused token says how to sign in again", async () => {
  const fetchImpl = (async () =>
    new Response('{"error":"invalid token"}', {
      status: 401,
    })) as unknown as typeof fetch;
  await expect(
    createClient("http://h", "imp_old", fetchImpl).get("/whoami"),
  ).rejects.toThrow(
    "Impression API 401: invalid token. Run `impression login` to sign in again.",
  );
});

test("clientName takes the machine from IMPRESSION_MACHINE when set", () => {
  expect(clientName("pi", { IMPRESSION_MACHINE: "ci-runner" })).toBe(
    "pi/dev (ci-runner)",
  );
  expect(clientName("mcp", { IMPRESSION_MACHINE: " " })).toBe(
    `mcp/dev (${hostname()})`,
  );
});
