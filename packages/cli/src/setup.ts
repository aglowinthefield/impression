import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * `impression setup`: finds installed agent harnesses and adds Impression's hooks, MCP
 * server and pi extension to each one's config. Idempotent, keeps unrelated settings, and
 * backs up each file before changing it.
 *
 * Opencode is left out: its config is JSONC and its hooks are plugins, neither of which
 * this writes safely.
 */

export const HARNESSES = ["claude", "pi", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface SetupOptions {
  home: string;
  /** Absolute path of the pi extension to register, if one ships with this install. */
  piExtension?: string;
  dryRun?: boolean;
  only?: Harness;
  /** Suffix for backup files. Defaults to a timestamp. */
  stamp?: string;
}

export interface Change {
  harness: Harness;
  file: string;
  what: string;
  status: "added" | "updated" | "unchanged";
}

export interface SetupResult {
  changes: Change[];
  notes: string[];
  /** Harnesses not found on this machine. */
  missing: Harness[];
  backups: string[];
}

const HOOK_START = "impression hook session-start";
const HOOK_END = "impression hook session-end --extract";
const MCP = "impression-mcp";

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

/** Adds or refreshes a command hook for an event. Matches an earlier Impression hook by its subcommand. */
function ensureHook(
  hooks: Json,
  event: string,
  command: string,
): Change["status"] {
  const sub = command.split(" ").slice(1, 3).join(" "); // "hook session-start"
  const groups = (
    Array.isArray(hooks[event]) ? hooks[event] : []
  ) as HookGroup[];
  hooks[event] = groups;
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      const c = h.command ?? "";
      if (
        c.includes(sub) &&
        c.includes("impression") &&
        !c.includes("petdex")
      ) {
        if (c === command) return "unchanged";
        h.command = command;
        return "updated";
      }
    }
  }
  groups.push({ hooks: [{ type: "command", command }] });
  return "added";
}

function ensureMcp(servers: Json, entry: Json): Change["status"] {
  const cur = servers.impression;
  const had = !!cur && typeof cur === "object";
  // Keep extra keys someone added (env, description), but point it at the bin.
  const next = had ? { ...(cur as Json), ...entry } : entry;
  if (had && JSON.stringify(next) === JSON.stringify(cur)) return "unchanged";
  servers.impression = next;
  return had ? "updated" : "added";
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
    const file = join(home, ".claude", "settings.json");
    w.edit(file, (settings) => {
      const hooks = obj(settings, "hooks");
      for (const [event, cmd] of [
        ["SessionStart", HOOK_START],
        ["SessionEnd", HOOK_END],
      ] as const)
        changes.push({
          harness: "claude",
          file,
          what: `${event} hook`,
          status: ensureHook(hooks, event, cmd),
        });
    });

    // User-scoped MCP servers live in ~/.claude.json, as `claude mcp add -s user` writes them.
    const mcpFile = join(home, ".claude.json");
    w.edit(mcpFile, (cfg) => {
      const status = ensureMcp(obj(cfg, "mcpServers"), {
        type: "stdio",
        command: MCP,
        args: [],
      });
      changes.push({
        harness: "claude",
        file: mcpFile,
        what: "MCP server",
        status,
      });
    });
  }

  if (want("pi") && found.pi) {
    const file = join(home, ".pi", "agent", "settings.json");
    if (opts.piExtension) {
      w.edit(file, (settings) => {
        const list = (
          Array.isArray(settings.extensions) ? settings.extensions : []
        ) as string[];
        const ext: string = opts.piExtension as string;
        // Replace an earlier copy (a checkout or an older install) rather than load two.
        const old = list.findIndex(
          (p) => typeof p === "string" && /(^|\/)pi\/impression\.ts$/.test(p),
        );
        let status: Change["status"] = "unchanged";
        if (old < 0) {
          list.push(ext);
          status = "added";
        } else if (list[old] !== ext) {
          list[old] = ext;
          status = "updated";
        }
        settings.extensions = list;
        changes.push({ harness: "pi", file, what: "extension", status });
      });
    } else
      notes.push("pi: extension file not found in this install, skipped it");

    const mcpFile = join(home, ".pi", "agent", "mcp.json");
    w.edit(mcpFile, (cfg) => {
      const status = ensureMcp(obj(cfg, "mcpServers"), { command: MCP });
      changes.push({
        harness: "pi",
        file: mcpFile,
        what: "MCP server",
        status,
      });
    });
  }

  if (want("codex") && found.codex) {
    // Codex reads Claude-style hooks from ~/.codex/hooks.json. Its SessionEnd transcript
    // is in Codex's own format, which session-end doesn't parse, so only SessionStart.
    const file = join(home, ".codex", "hooks.json");
    w.edit(file, (cfg) => {
      changes.push({
        harness: "codex",
        file,
        what: "SessionStart hook",
        status: ensureHook(obj(cfg, "hooks"), "SessionStart", HOOK_START),
      });
    });

    const toml = join(home, ".codex", "config.toml");
    const text = existsSync(toml) ? readFileSync(toml, "utf8") : "";
    const has = /^\[mcp_servers\.impression\]/m.test(text);
    if (!has) {
      const sep = !text ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      w.write(
        toml,
        `${text}${sep}[mcp_servers.impression]\ncommand = "${MCP}"\n`,
      );
    }
    changes.push({
      harness: "codex",
      file: toml,
      what: "MCP server",
      status: has ? "unchanged" : "added",
    });
    if (!/^\s*hooks\s*=\s*true/m.test(text))
      notes.push(
        "codex: hooks run only with `hooks = true` under [features] in ~/.codex/config.toml",
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
  if (!r.changes.length) lines.push("No supported harness found.");
  return lines.join("\n");
}
