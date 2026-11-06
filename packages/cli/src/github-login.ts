interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface GithubLoginDeps {
  fetch?: typeof fetch;
  /** Waits `ms`. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Shows the code to the person. */
  print?: (line: string) => void;
}

/**
 * Signs in through GitHub's device flow, mediated by the server so the CLI never
 * holds the client secret. Returns the Impression token and the GitHub login.
 */
export async function githubDeviceLogin(
  baseUrl: string,
  deps: GithubLoginDeps = {},
): Promise<{ token: string; name: string }> {
  const f = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const print = deps.print ?? console.log;
  const root = `${baseUrl.replace(/\/+$/, "")}/auth/github`;
  const post = async (path: string, body?: unknown) => {
    const res = await f(`${root}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { res, json };
  };

  const start = await post("/device");
  if (!start.res.ok) {
    throw new Error(
      start.res.status === 404
        ? "This server doesn't have GitHub sign-in turned on."
        : String(start.json?.error ?? `Server returned ${start.res.status}`),
    );
  }
  const device = start.json as unknown as DeviceStart;
  print(`Open ${device.verificationUri} and enter the code ${device.userCode}`);

  let interval = device.interval;
  const deadline = Date.now() + device.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const poll = await post("/device/poll", { deviceCode: device.deviceCode });
    if (poll.res.status === 202) {
      // GitHub asks for slower polling by adding 5 seconds.
      if (poll.json?.status === "slow_down") interval += 5;
      continue;
    }
    if (!poll.res.ok) {
      throw new Error(
        String(poll.json?.error ?? `Server returned ${poll.res.status}`),
      );
    }
    return {
      token: String(poll.json?.token),
      name: String(poll.json?.name),
    };
  }
  throw new Error("The code expired. Run the login again.");
}
