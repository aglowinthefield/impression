import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  url: string;
  token?: string;
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
    url: env.IMPRESSION_URL ?? saved.url ?? "http://localhost:3000",
    token: env.IMPRESSION_TOKEN ?? saved.token,
  };
}

export function saveConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
