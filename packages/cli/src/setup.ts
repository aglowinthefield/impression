import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `impression setup`: finds installed agent harnesses and wires Impression into each.
 * pi gets the package entry; Claude Code and Codex get their plugin install commands,
 * and lose the hooks and MCP entries earlier setups wrote. Idempotent, keeps unrelated
 * settings, and backs up each file before changing it.
 *
 * Opencode is left out: its config is JSONC and its hooks are plugins, neither of which
 * this writes safely.
 */

export const HARNESSES = ["claude", "pi", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface SetupOptions {
  home: string;
  dryRun?: boolean;
  only?: Harness;
  /** Suffix for backup files. Defaults to a timestamp. */
  stamp?: string;
}

export interface Change {
  harness: Harness;
  file: string;
  what: string;
  status: "added" | "updated" | "unchanged" | "removed";
}

export interface SetupResult {
  changes: Change[];
  notes: string[];
  /** Harnesses not found on this machine. */
  missing: Harness[];
  backups: string[];
}

export const CLAUDE_INSTALL = [
  "claude plugin marketplace add aglowinthefield/impression",
  "claude plugin install impression@impression",
];
export const CODEX_INSTALL = [
  "codex plugin marketplace add aglowinthefield/impression",
  "codex plugin add impression@impression",
];
const MCP = "impression-mcp";
/** pi installs this package itself, extension and MCP server included. */
export const PI_PACKAGE = "npm:@aglowinthefield/impression";

type Json = Record<string, unknown>;
interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

function readJson(file: string): Json {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${file} is not a JSON object`);
  return parsed as Json;
}

function obj(parent: Json, key: string): Json {
  const v = parent[key];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Json;
  const fresh: Json = {};
  parent[key] = fresh;
  return fresh;
}

/** An Impression hook, from PATH or from a checkout (`node .../impression/.../bin.js hook ...`). */
const IMPRESSION_HOOK =
  /impression\S*(\s\S+)*\shook (session-start|session-end|prompt)\b/;

/** Removes the Impression hooks an earlier setup wrote. Returns how many. */
function removeHooks(hooks: unknown): number {
  if (!hooks || typeof hooks !== "object") return 0;
  let n = 0;
  const all = hooks as Record<string, unknown>;
  for (const [event, value] of Object.entries(all)) {
    if (!Array.isArray(value)) continue;
    const groups = (value as HookGroup[]).flatMap((g) => {
      const kept = (g.hooks ?? []).filter(
        (h) => !IMPRESSION_HOOK.test(h.command ?? ""),
      );
      n += (g.hooks?.length ?? 0) - kept.length;
      return kept.length ? [{ ...g, hooks: kept }] : g.hooks?.length ? [] : [g];
    });
    if (groups.length || !value.length) all[event] = groups;
    else delete all[event];
  }
  return n;
}

/** Removes the `impression` MCP server setup wrote (run from PATH); one pointed elsewhere stays. */
function removeMcp(servers: unknown): boolean {
  const s = servers as Json | undefined;
  const cur = s?.impression as Json | undefined;
  if (!s || cur?.command !== MCP) return false;
  delete s.impression;
  return true;
}

class Writer {
  backups: string[] = [];
  constructor(private opts: SetupOptions) {}
  stamp = () =>
    this.opts.stamp ??
    new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  write(file: string, text: string) {
    const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (before === text || this.opts.dryRun) return;
    if (before !== undefined) {
      const backup = `${file}.impression-backup-${this.stamp()}`;
      copyFileSync(file, backup);
      this.backups.push(backup);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  /** Loads a JSON file, applies `fn`, and writes only if the data changed. */
  edit(file: string, fn: (data: Json) => void) {
    const data = readJson(file);
    const before = JSON.stringify(data);
    fn(data);
    if (JSON.stringify(data) !== before)
      this.write(file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Config files still holding Impression hooks an earlier setup wrote. The plugins replace them. */
export function oldHookFiles(home: string = homedir()): string[] {
  return [
    join(home, ".claude", "settings.json"),
    join(home, ".codex", "hooks.json"),
  ].filter((f) => {
    try {
      return IMPRESSION_HOOK.test(readFileSync(f, "utf8"));
    } catch {
      return false;
    }
  });
}

export function setup(opts: SetupOptions): SetupResult {
  const { home } = opts;
  const w = new Writer(opts);
  const changes: Change[] = [];
  const notes: string[] = [];
  const missing: Harness[] = [];
  const want = (h: Harness) => !opts.only || opts.only === h;
  const found = {
    claude: existsSync(join(home, ".claude")),
    pi: existsSync(join(home, ".pi", "agent")),
    codex: existsSync(join(home, ".codex")),
  };

  for (const h of HARNESSES) if (want(h) && !found[h]) missing.push(h);

  if (want("claude") && found.claude) {
    // Claude Code installs the plugin, which brings the hooks and MCP server.
    // Take out what earlier setups wrote, so nothing runs twice.
    const file = join(home, ".claude", "settings.json");
    if (existsSync(file))
      w.edit(file, (settings) => {
        const n = removeHooks(settings.hooks);
        if (n)
          changes.push({
            harness: "claude",
            file,
            what: "old hooks",
            status: "removed",
          });
      });
    const mcpFile = join(home, ".claude.json");
    if (existsSync(mcpFile))
      w.edit(mcpFile, (cfg) => {
        if (removeMcp(cfg.mcpServers))
          changes.push({
            harness: "claude",
            file: mcpFile,
            what: "old MCP server",
            status: "removed",
          });
      });
    notes.push(
      `claude: install the plugin with\n  ${CLAUDE_INSTALL.join("\n  ")}`,
    );
  }

  if (want("pi") && found.pi) {
    // The npm package is a pi package, so pi installs, updates and loads it. Earlier
    // setups pointed "extensions" at the file and added an MCP entry run from PATH;
    // take those out so nothing loads twice.
    const file = join(home, ".pi", "agent", "settings.json");
    w.edit(file, (settings) => {
      const pkgs = (
        Array.isArray(settings.packages) ? settings.packages : []
      ) as unknown[];
      const has = pkgs.some((p) => {
        const src = typeof p === "string" ? p : (p as Json)?.source;
        return (
          typeof src === "string" && src.split(/@(?=[^/]*$)/)[0] === PI_PACKAGE
        );
      });
      if (!has) pkgs.push(PI_PACKAGE);
      settings.packages = pkgs;
      changes.push({
        harness: "pi",
        file,
        what: "package",
        status: has ? "unchanged" : "added",
      });

      if (Array.isArray(settings.extensions)) {
        const list = settings.extensions as unknown[];
        const kept = list.filter(
          (p) =>
            !(typeof p === "string" && /(^|\/)pi\/impression\.ts$/.test(p)),
        );
        if (kept.length < list.length) {
          settings.extensions = kept;
          changes.push({
            harness: "pi",
            file,
            what: "old extension path",
            status: "removed",
          });
        }
      }
    });

    const mcpFile = join(home, ".pi", "agent", "mcp.json");
    if (existsSync(mcpFile))
      w.edit(mcpFile, (cfg) => {
        const servers = cfg.mcpServers as Json | undefined;
        const cur = servers?.impression as Json | undefined;
        // Only the entry setup wrote; one someone pointed elsewhere stays.
        if (servers && cur?.command === MCP) {
          delete servers.impression;
          changes.push({
            harness: "pi",
            file: mcpFile,
            what: "old MCP server",
            status: "removed",
          });
        }
      });
  }

  if (want("codex") && found.codex) {
    const file = join(home, ".codex", "hooks.json");
    if (existsSync(file))
      w.edit(file, (cfg) => {
        if (removeHooks(cfg.hooks))
          changes.push({
            harness: "codex",
            file,
            what: "old hooks",
            status: "removed",
          });
      });
    const toml = join(home, ".codex", "config.toml");
    if (existsSync(toml)) {
      const text = readFileSync(toml, "utf8");
      // Only the table setup wrote: `[mcp_servers.impression]` run from PATH.
      const next = text.replace(
        /^\[mcp_servers\.impression\]\ncommand = "impression-mcp"\n(\n(?=\[))?/m,
        "",
      );
      if (next !== text) {
        w.write(toml, next);
        changes.push({
          harness: "codex",
          file: toml,
          what: "old MCP server",
          status: "removed",
        });
      }
    }
    notes.push(
      `codex: install the plugin with\n  ${CODEX_INSTALL.join("\n  ")}`,
    );
  }

  return { changes, notes, missing, backups: w.backups };
}

export function formatSetup(r: SetupResult, dryRun = false): string {
  const lines = r.changes.map(
    (c) =>
      `${c.harness}: ${c.what} ${dryRun && c.status !== "unchanged" ? `would be ${c.status}` : c.status} (${c.file})`,
  );
  if (r.missing.length) lines.push(`not found: ${r.missing.join(", ")}`);
  lines.push(...r.notes);
  for (const b of r.backups) lines.push(`backup: ${b}`);
  if (!r.changes.length && !r.notes.length)
    lines.push("No supported harness found.");
  return lines.join("\n");
}
