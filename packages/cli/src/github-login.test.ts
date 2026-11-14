import { expect, test } from "vitest";
import { githubDeviceLogin } from "./github-login.js";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });
const device = {
  deviceCode: "d1",
  userCode: "ABCD-1234",
  verificationUri: "https://github.com/login/device",
  interval: 5,
  expiresIn: 900,
};

function harness(polls: Response[], start = reply(200, device)) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  const opened: string[] = [];
  const queue = [...polls];
  return {
    calls,
    sleeps,
    lines,
    opened,
    run: () =>
      githubDeviceLogin("http://srv/", {
        fetch: (async (url: string) => {
          calls.push(url);
          return url.endsWith("/device") ? start : queue.shift();
        }) as typeof fetch,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        print: (l) => lines.push(l),
        open: (u) => opened.push(u),
      }),
  };
}

test("shows the code, polls until approved and returns the token", async () => {
  const h = harness([
    reply(202, { status: "pending" }),
    reply(202, { status: "slow_down" }),
    reply(200, { status: "ok", token: "imp_x", name: "sam" }),
  ]);
  expect(await h.run()).toEqual({ token: "imp_x", name: "sam" });
  expect(h.lines[0]).toContain("ABCD-1234");
  expect(h.opened).toEqual(["https://github.com/login/device"]);
  expect(h.calls[0]).toBe("http://srv/auth/github/device");
  // slow_down adds 5 seconds to every later wait.
  expect(h.sleeps).toEqual([5000, 5000, 10000]);
});

test("surfaces the server's refusal", async () => {
  const h = harness([
    reply(403, { error: "sam isn't on this server's allowlist." }),
  ]);
  await expect(h.run()).rejects.toThrow("allowlist");
});

test("explains a server without GitHub sign-in", async () => {
  const h = harness([], reply(404, {}));
  await expect(h.run()).rejects.toThrow("turned on");
});
