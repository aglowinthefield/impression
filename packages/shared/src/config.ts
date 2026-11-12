import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  url: string;
  token?: string;
  /** Send AGENTS.md / CLAUDE.md to extraction so it skips rules they already state. Off by default. */
  sendInstructions?: boolean;
}

export const configPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "impression",
    "config.json",
  );

/** Environment wins over the saved file, so hooks and CI can override it. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch {}
  return {
    url: env.IMPRESSION_URL ?? saved.url ?? "https://impression.quest",
    token: env.IMPRESSION_TOKEN ?? saved.token,
    sendInstructions: env.IMPRESSION_SEND_INSTRUCTIONS
      ? /^(1|true|yes|on)$/i.test(env.IMPRESSION_SEND_INSTRUCTIONS)
      : saved.sendInstructions === true,
  };
}

export function saveConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  // Keep options the caller didn't pass, like sendInstructions, across a re-login.
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  const merged = { ...saved, ...config };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
