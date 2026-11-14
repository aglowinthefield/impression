import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ApiClient, resolveProject } from "@impression/shared";
import { projectCandidates } from "./candidates.js";

/** Keep well under the API's 2M character limit. */
const MAX_CHARS = 1_500_000;

type Role = "user" | "assistant";
type Entry = Record<string, unknown> & {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  payload?: { type?: string; role?: string; content?: unknown };
  data?: { content?: unknown };
  content?: unknown;
  id?: string;
};

/** Text from string content or an array of `{type?, text}` blocks, skipping tool blocks. */
function blockText(content: unknown, types: string[] = ["text"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b: { type?: string; text?: unknown }) =>
      typeof b?.text === "string" &&
      (b.type === undefined || types.includes(b.type))
        ? [b.text]
        : [],
    )
    .join("\n")
    .trim();
}

/** Codex puts instruction files and environment notes into user messages. */
const CODEX_INJECTED =
  /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>)/;

/** One line of any supported transcript, as a role and its text, or null for noise. */
function turn(entry: Entry): [Role, string] | null {
  // Codex rollout: `{type: "response_item", payload: {type: "message", role, content}}`.
  if (entry.type === "response_item") {
    const p = entry.payload;
    if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant"))
      return null;
    const blocks = Array.isArray(p.content)
      ? p.content.filter(
          (b: { text?: unknown }) =>
            !(typeof b?.text === "string" && CODEX_INJECTED.test(b.text)),
        )
      : p.content;
    return [p.role, blockText(blocks, ["input_text", "output_text"])];
  }
  // Copilot CLI events: `{type: "user.message"|"assistant.message", data: {content}}`.
  if (entry.type === "user.message" || entry.type === "assistant.message") {
    return [
      entry.type === "user.message" ? "user" : "assistant",
      blockText(entry.data?.content),
    ];
  }
  // Gemini CLI: `{type: "user"|"gemini", content}` with no `message`.
  if (
    entry.type === "gemini" ||
    (entry.type === "user" && !entry.message && "content" in entry)
  ) {
    return [
      entry.type === "gemini" ? "assistant" : "user",
      blockText(entry.content),
    ];
  }
  // pi `{type: "message", message: {role}}`, Claude Code `{type: "user"|"assistant"}`,
  // Cursor `{role, message}` with no type.
  const role =
    entry.type === "message" ? entry.message?.role : (entry.type ?? entry.role);
  if (role !== "user" && role !== "assistant") return null;
  return [role, blockText(entry.message?.content)];
}

/**
 * Lines of a JSONL transcript, or the messages of Gemini's older single-JSON file.
 * Gemini's JSONL rewrites earlier lines with `{$patch: {id, ...}}` and drops later
 * ones, that id included, with `{$rewindTo: id}`; both are applied here.
 */
export function entries(raw: string): Entry[] {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    try {
      const doc = JSON.parse(trimmed);
      if (Array.isArray(doc?.messages)) return doc.messages;
    } catch {}
  }
  const out: Entry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const patch = e.$patch as Entry | undefined;
    if (patch?.id) {
      const i = out.findLastIndex((x) => x.id === patch.id);
      if (i >= 0) out[i] = { ...out[i], ...patch };
      continue;
    }
    if (typeof e.$rewindTo === "string") {
      const i = out.findLastIndex((x) => x.id === e.$rewindTo);
      out.length = Math.max(i, 0);
      continue;
    }
    if (e.id && e.type) {
      const i = out.findLastIndex((x) => x.id === e.id);
      if (i >= 0) {
        out[i] = e;
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

/**
 * Flattens an agent's transcript to "role: text" lines, skipping tool noise. Reads
 * Claude Code, pi, Codex, Cursor, Gemini CLI and Copilot CLI transcripts.
 */
export function transcriptText(raw: string): string {
  const out: string[] = [];
  for (const e of entries(raw)) {
    const t = turn(e);
    if (t?.[1]) out.push(`${t[0]}: ${t[1]}`);
  }
  const all = out.join("\n\n");
  return all.length > MAX_CHARS ? all.slice(-MAX_CHARS) : all;
}

const MAX_INSTRUCTION_CHARS = 8_000;

/**
 * Instruction files the agent loads for this directory: project and global
 * AGENTS.md / CLAUDE.md. Missing files are skipped. Each is cut to a cap.
 */
export function readInstructions(
  cwd: string,
  home: string = homedir(),
): string | undefined {
  const files = [
    join(cwd, "AGENTS.md"),
    join(cwd, "CLAUDE.md"),
    join(home, ".pi", "agent", "AGENTS.md"),
    join(home, ".claude", "CLAUDE.md"),
  ];
  const parts: string[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(f, "utf8").trim();
      if (text) parts.push(`# ${f}\n${text.slice(0, MAX_INSTRUCTION_CHARS)}`);
    } catch {}
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

function headSha(cwd: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Candidates are a bonus: if working them out fails, the session still uploads. */
function safeCandidates(raw: string, cwd: string, key: string) {
  try {
    return projectCandidates(entries(raw), cwd, key);
  } catch {
    return [];
  }
}

export interface SessionEndInput {
  transcript_path?: string;
  cwd?: string;
  /** The agent's own session id, sent as `sessionKey`. */
  session_id?: string;
}

/** What POST /sessions/:id/extract reports. */
export interface ExtractSummary {
  accepted?: number;
  skippedDuplicates?: number;
  skippedEmpty?: number;
  skippedRepeats?: number;
  skippedBelowFloor?: number;
  skippedNoAccess?: number;
}

export interface UploadOptions {
  extract?: boolean;
  agent?: string;
  sendInstructions?: boolean;
  /** Extract even when the server already had the chunk, for a retry whose first reply got lost. */
  extractDuplicate?: boolean;
}

export interface UploadResult {
  id: string;
  duplicate: boolean;
  /** Set when extraction ran. */
  extracted?: ExtractSummary;
}

/**
 * Uploads one transcript chunk to ingest and, with extract, asks the API to
 * propose memories from it. Returns null when the chunk has no conversation
 * text. Throws on any API or network error; `sendSession` is the hook-safe
 * wrapper.
 */
export async function uploadSession(
  client: ApiClient,
  input: { raw: string; cwd: string; sessionKey?: string },
  opts: UploadOptions = {},
): Promise<UploadResult | null> {
  const { raw, cwd } = input;
  const transcript = transcriptText(raw);
  if (!transcript) return null;
  const p = resolveProject(cwd);
  const candidates = safeCandidates(raw, cwd, p.key);
  const { id, duplicate } = (await client.post("/sessions", {
    project: { key: p.key, name: p.name },
    // Older servers ignore this; extraction there files everything under `project`.
    ...(candidates.length ? { candidates } : {}),
    transcript,
    commitSha: headSha(cwd),
    agent: opts.agent ?? "claude-code",
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  })) as { id: string; duplicate?: boolean };
  const result: UploadResult = { id, duplicate: duplicate === true };
  // The server already had this chunk, and extracted it then if asked.
  if (opts.extract && (!duplicate || opts.extractDuplicate)) {
    const instructions = opts.sendInstructions
      ? readInstructions(cwd)
      : undefined;
    const summary = await client.post(
      `/sessions/${id}/extract`,
      instructions ? { instructions } : {},
    );
    result.extracted =
      summary && typeof summary === "object" ? (summary as ExtractSummary) : {};
  }
  return result;
}

/**
 * Sends the finished session to ingest. Returns the session id, or null when
 * there is nothing to send or anything fails: a hook must never break exit.
 * With extract, also asks the API to propose memories from it, and with
 * sendInstructions attaches the instruction files so it skips what they say.
 */
export async function sendSession(
  client: ApiClient,
  input: SessionEndInput,
  opts: { extract?: boolean; agent?: string; sendInstructions?: boolean } = {},
): Promise<string | null> {
  try {
    if (!input.transcript_path) return null;
    const raw = readFileSync(input.transcript_path, "utf8");
    const result = await uploadSession(
      client,
      {
        raw,
        cwd: input.cwd ?? process.cwd(),
        ...(input.session_id ? { sessionKey: input.session_id } : {}),
      },
      opts,
    );
    return result?.id ?? null;
  } catch {
    return null;
  }
}
