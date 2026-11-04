import { describe, expect, test } from "vitest";
import { createClient } from "./client.js";

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
    await expect(c.get("/core")).rejects.toThrow("422");
    expect(seen?.method).toBe("GET");
    expect(seen?.url).toBe("http://h:3000/api/core");
  });
});
