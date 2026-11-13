import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { resolveProject } from "@impression/shared";

/** A repo the session's tool calls touched, sent so extraction can file memories there. */
export interface ProjectCandidate {
  key: string;
  name: string;
  headSha?: string;
  /** Edits, writes and commands run in the repo. */
  edits: number;
  /** Read-only hits: reads, searches, paths a command only mentioned. */
  reads: number;
  /** Repo-relative files touched, edits first, so anchors can be checked against the repo. */
  files: string[];
}

export const MAX_CANDIDATES = 10;
const MAX_FILES = 50;
/** Bounds the git calls a long session can cause at exit. */
const MAX_DIRS = 300;

/** A path a tool call touched. `base` is where a relative path is resolved from. */
export interface Touch {
  path: string;
  kind: "edit" | "read";
  /** A directory the agent worked in (cd, workdir), not a file. */
  dir?: boolean;
  base?: string;
}

type Call = { name: string; args: unknown };

const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "write",
  "notebookedit",
  "create",
  "replace",
  "writefile",
  "editfile",
  "strreplace",
  "searchreplace",
  "applypatch",
  "delete",
  "deletefile",
]);
const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "execcommand",
  "runshellcommand",
  "localshell",
  "localshellcall",
  "powershell",
  "runterminalcmd",
  "shellcommand",
]);
/** Tools that run a script calling other tools (pi codemode, Codex exec). */
const SCRIPT_TOOLS = new Set(["codemode", "exec"]);
const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "absolute_path",
  "notebook_path",
  "target_file",
  "target_directory",
];
const LIST_KEYS = ["paths", "file_paths"];
const DIR_KEYS = [
  "workdir",
  "cwd",
  "working_directory",
  "directory",
  "dir_path",
];

const norm = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** JSON in a string (Codex function_call arguments), or the string itself. */
function parseArgs(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** The tool calls in one transcript line, for every format `transcriptText` reads. */
function callsOf(entry: unknown): Call[] {
  const e = rec(entry);
  const out: Call[] = [];
  // pi `toolCall`, Claude Code and Cursor `tool_use` blocks.
  const content = rec(e.message).content;
  if (Array.isArray(content)) {
    for (const b of content) {
      const r = rec(b);
      if ((r.type === "toolCall" || r.type === "tool_use") && str(r.name))
        out.push({ name: r.name as string, args: r.arguments ?? r.input });
    }
  }
  // Codex rollout items.
  if (e.type === "response_item") {
    const p = rec(e.payload);
    if (p.type === "function_call" || p.type === "custom_tool_call")
      out.push({
        name: str(p.name) ?? "",
        args: parseArgs(p.arguments ?? p.input),
      });
    else if (p.type === "local_shell_call")
      out.push({ name: "local_shell", args: p.action });
  }
  // Gemini CLI messages carry `toolCalls: [{name, args}]`.
  if (Array.isArray(e.toolCalls)) {
    for (const c of e.toolCalls) {
      const r = rec(c);
      if (str(r.name)) out.push({ name: r.name as string, args: r.args });
    }
  }
  // Copilot CLI events.
  if (e.type === "tool.execution_start") {
    const d = rec(e.data);
    if (str(d.toolName))
      out.push({ name: d.toolName as string, args: parseArgs(d.arguments) });
  }
  return out;
}

const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/, "$2");
const ARG = String.raw`("[^"]+"|'[^']+'|[^\s;&|)'"\x60]+)`;
const CD = new RegExp(String.raw`(?:^|[\s;&|(])cd\s+(?:--\s+)?${ARG}`, "g");
const DIR_FLAG = new RegExp(
  String.raw`(?:\s-C|\s--cwd|\s--dir|\s--prefix)(?:=|\s+)${ARG}`,
  "g",
);
/** Absolute or home paths in free text. `//` would be a URL. */
const ABS = /(?:^|[\s"'=(`])((?:~\/|\/(?!\/))[^\s"'`;&|()<>,]+)/g;
const PATCH_FILE =
  /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** Directories a shell command works in, and paths it only mentions. */
function shellTouches(cmd: string, base?: string): Touch[] {
  const out: Touch[] = [];
  // Spans already read as working directories, so ABS doesn't count them again.
  const spans: [number, number][] = [];
  for (const re of [CD, DIR_FLAG]) {
    for (const m of cmd.matchAll(re)) {
      spans.push([m.index, m.index + m[0].length]);
      const d = unquote(m[1] as string);
      if (d === "-" || d.startsWith("$")) continue;
      out.push({ path: d, kind: "edit", dir: true, base });
    }
  }
  for (const m of cmd.matchAll(ABS)) {
    const at = m.index + m[0].indexOf(m[1] as string);
    if (!spans.some(([a, b]) => at >= a && at < b))
      out.push({ path: m[1] as string, kind: "read", base });
  }
  return out;
}

function patchTouches(text: string, base?: string): Touch[] {
  return [...text.matchAll(PATCH_FILE)].map((m) => ({
    path: (m[1] ?? m[2] ?? "").trim(),
    kind: "edit" as const,
    base,
  }));
}

/** Edits a script makes through `edit({path})` / `write({path})`, cds it runs, paths it mentions. */
function scriptTouches(code: string): Touch[] {
  const out: Touch[] = [];
  const edited = new Set<string>();
  for (const m of code.matchAll(
    /\b(?:edit|write|apply_patch)\(\s*\{[^}]*?\bpath:\s*(["'`])(.+?)\1/g,
  )) {
    edited.add(m[2] as string);
    out.push({ path: m[2] as string, kind: "edit" });
  }
  out.push(...patchTouches(code));
  for (const t of shellTouches(code)) if (!edited.has(t.path)) out.push(t);
  return out;
}

function callTouches({ name, args }: Call): Touch[] {
  const n = norm(name);
  if (typeof args === "string") {
    if (n === "applypatch") return patchTouches(args);
    if (SCRIPT_TOOLS.has(n)) return scriptTouches(args);
    return SHELL_TOOLS.has(n) ? shellTouches(args) : [];
  }
  const a = rec(args);
  const out: Touch[] = [];
  const shell = SHELL_TOOLS.has(n);
  const workdir = DIR_KEYS.map((k) => str(a[k])).find(Boolean);
  if (workdir)
    out.push({ path: workdir, kind: shell ? "edit" : "read", dir: true });
  if (shell) {
    const cmd = Array.isArray(a.command)
      ? a.command.filter((x) => typeof x === "string").join(" ")
      : (str(a.command) ?? str(a.cmd));
    if (cmd) out.push(...shellTouches(cmd, workdir));
    return out;
  }
  if (SCRIPT_TOOLS.has(n)) {
    const code = str(a.code) ?? str(a.input);
    return code ? [...out, ...scriptTouches(code)] : out;
  }
  if (n === "applypatch") {
    const patch = str(a.input) ?? str(a.patch);
    return patch ? [...out, ...patchTouches(patch, workdir)] : out;
  }
  // Copilot's str_replace_editor names its action in `command`.
  const edit =
    n === "strreplaceeditor"
      ? a.command !== "view"
      : EDIT_TOOLS.has(n) || EDIT_TOOLS.has(n.replace(/s$/, ""));
  const kind = edit ? "edit" : "read";
  for (const k of PATH_KEYS) {
    const p = str(a[k]);
    if (p) out.push({ path: p, kind, base: workdir });
  }
  for (const k of LIST_KEYS) {
    if (Array.isArray(a[k]))
      for (const p of a[k] as unknown[])
        if (str(p)) out.push({ path: p as string, kind, base: workdir });
  }
  return out;
}

/** Paths the transcript's tool calls read, edited or ran commands in. */
export function toolTouches(entries: unknown[]): Touch[] {
  return entries.flatMap((e) => callsOf(e).flatMap(callTouches));
}

function gitOut(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The nearest existing directory at or above `p`, real path, plus the rest of `p` below it. */
function existingDir(p: string): { dir: string; rest: string } | null {
  let cur = p;
  let rest = "";
  for (;;) {
    try {
      if (existsSync(cur)) {
        const real = realpathSync(cur);
        if (statSync(real).isDirectory()) return { dir: real, rest };
        return { dir: dirname(real), rest: join(basename(real), rest) };
      }
    } catch {
      return null;
    }
    const up = dirname(cur);
    if (up === cur) return null;
    rest = rest ? join(basename(cur), rest) : basename(cur);
    cur = up;
  }
}

/**
 * Repos the session touched, by git remote key. `path:` projects never count:
 * work outside a repo with a remote stays with the session's project. Empty
 * when the session never left `sessionKey`, so single-repo uploads don't change.
 */
export function projectCandidates(
  entries: unknown[],
  cwd: string,
  sessionKey: string,
  home: string = homedir(),
): ProjectCandidate[] {
  const toplevels = new Map<string, string | null>();
  const keys = new Map<string, { key: string; name: string } | null>();
  const byKey = new Map<
    string,
    ProjectCandidate & {
      edited: Set<string>;
      read: Set<string>;
      tops: Map<string, number>;
    }
  >();
  for (const t of toolTouches(entries)) {
    const raw = t.path.startsWith("~/") ? join(home, t.path.slice(2)) : t.path;
    const abs = isAbsolute(raw) ? raw : resolve(t.base ?? cwd, raw);
    const found = existingDir(abs);
    if (!found) continue;
    if (!toplevels.has(found.dir)) {
      if (toplevels.size >= MAX_DIRS) continue;
      toplevels.set(
        found.dir,
        gitOut(found.dir, "rev-parse", "--show-toplevel"),
      );
    }
    const top = toplevels.get(found.dir);
    if (!top) continue;
    if (!keys.has(top)) {
      const p = resolveProject(top);
      keys.set(
        top,
        p.key.startsWith("path:") ? null : { key: p.key, name: p.name },
      );
    }
    const id = keys.get(top);
    if (!id) continue;
    let c = byKey.get(id.key);
    if (!c) {
      c = {
        ...id,
        edits: 0,
        reads: 0,
        files: [],
        edited: new Set(),
        read: new Set(),
        tops: new Map(),
      };
      byKey.set(id.key, c);
    }
    if (t.kind === "edit") {
      c.edits++;
      c.tops.set(top, (c.tops.get(top) ?? 0) + 1);
    } else c.reads++;
    if (!t.dir && found.rest) {
      const rel = relative(top, join(found.dir, found.rest))
        .split(sep)
        .join("/");
      if (rel && !rel.startsWith(".."))
        (t.kind === "edit" ? c.edited : c.read).add(rel);
    }
  }
  if (![...byKey.keys()].some((k) => k !== sessionKey)) return [];
  return [...byKey.values()]
    .sort((a, b) => b.edits - a.edits || b.reads - a.reads)
    .slice(0, MAX_CANDIDATES)
    .map(({ edited, read, tops, ...c }) => {
      // Worktrees of one repo share a key; the one edited most has the relevant HEAD.
      const top =
        [...tops.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
        [...toplevels.values()].find((v) => v && keys.get(v)?.key === c.key);
      const sha = top ? gitOut(top, "rev-parse", "HEAD") : null;
      const files = [...new Set([...edited, ...read])].slice(0, MAX_FILES);
      return {
        ...c,
        ...(sha && /^[0-9a-f]{7,40}$/i.test(sha) ? { headSha: sha } : {}),
        files,
      };
    });
}
