import { expect, test } from "vitest";
import { login } from "./login.js";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

/** A server that knows one token, `imp_good`, and approves GitHub sign-in at once. */
function server() {
  const calls: string[] = [];
  const lines: string[] = [];
  const deps = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/auth/github/device"))
        return reply(200, {
          deviceCode: "d1",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          interval: 5,
          expiresIn: 900,
        });
      if (url.endsWith("/auth/github/device/poll"))
        return reply(200, { token: "imp_good", name: "tom" });
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer imp_good"
        ? reply(200, { name: "tom" })
        : reply(401, { error: "invalid token" });
    }) as typeof fetch,
    sleep: async () => {},
    print: (l: string) => lines.push(l),
  };
  return { calls, lines, deps };
}

test("a refused saved token falls through to GitHub sign-in", async () => {
  const s = server();
  await expect(
    login({ url: "http://srv", saved: "imp_revoked" }, s.deps),
  ).resolves.toEqual({ token: "imp_good", name: "tom" });
  expect(s.lines[0]).toBe(
    "The saved token was refused. Signing in with GitHub instead.",
  );
  expect(s.calls).toContain("http://srv/auth/github/device");
});

test("a working saved token is kept without GitHub", async () => {
  const s = server();
  await expect(
    login({ url: "http://srv", saved: "imp_good" }, s.deps),
  ).resolves.toEqual({ token: "imp_good", name: "tom" });
  expect(s.calls).toEqual(["http://srv/api/whoami"]);
});

test("no saved token signs in with GitHub", async () => {
  const s = server();
  await expect(login({ url: "http://srv" }, s.deps)).resolves.toEqual({
    token: "imp_good",
    name: "tom",
  });
});

test("--token is checked as given, never replaced", async () => {
  const s = server();
  await expect(
    login({ url: "http://srv", token: "imp_bad", saved: "imp_good" }, s.deps),
  ).rejects.toThrow("Impression API 401");
  expect(s.calls).toEqual(["http://srv/api/whoami"]);
});
