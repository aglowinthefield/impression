import { createClient } from "@impression/shared";
import { type GithubLoginDeps, githubDeviceLogin } from "./github-login.js";

export interface LoginOptions {
  url: string;
  /** `--token`: sign in with this token. */
  token?: string;
  /** `--github`: sign in through GitHub even when a saved token works. */
  github?: boolean;
  /** The token saved by an earlier login, if any. */
  saved?: string;
}

/**
 * `impression login`. With `--token`, checks and keeps that token. Otherwise it
 * re-checks the saved token, and when there is none or the server refuses it
 * (revoked or expired), signs in through GitHub. Returns the token to save.
 */
export async function login(
  opts: LoginOptions,
  deps: GithubLoginDeps = {},
): Promise<{ token: string; name: string }> {
  const print = deps.print ?? console.log;
  const whoami = async (token: string) =>
    (
      (await createClient(opts.url, token, deps.fetch).get("/whoami")) as {
        name: string;
      }
    ).name;

  if (opts.token) return { token: opts.token, name: await whoami(opts.token) };
  if (opts.saved && !opts.github) {
    try {
      return { token: opts.saved, name: await whoami(opts.saved) };
    } catch (e) {
      if (!/^Impression API 401\b/.test((e as Error).message)) throw e;
      print("The saved token was refused. Signing in with GitHub instead.");
    }
  }
  const signedIn = await githubDeviceLogin(opts.url, deps);
  return { token: signedIn.token, name: await whoami(signedIn.token) };
}
