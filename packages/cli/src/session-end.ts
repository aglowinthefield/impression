import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type ApiClient, resolveProject } from "@impression/shared";

/** Keep well under the API's 2M character limit. */
const MAX_CHARS = 1_500_000;

/**
 * Flattens a Claude Code or pi JSONL transcript to "role: text" lines, skipping tool noise.
 * Claude Code lines are `{type: "user"|"assistant", message}`; pi's are
 * `{type: "message", message: {role, content}}`.
 */
export function transcriptText(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry.type === "message" ? entry.message?.role : entry.type;
    if (role !== "user" && role !== "assistant") continue;
    const content = entry.message?.content;
    const parts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.flatMap((b: { type?: string; text?: string }) =>
              b.type === "text" && b.text ? [b.text] : [],
            )
          : [];
    const text = parts.join("\n").trim();
    if (text) out.push(`${role}: ${text}`);
  }
  const all = out.join("\n\n");
  return all.length > MAX_CHARS ? all.slice(-MAX_CHARS) : all;
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

export interface SessionEndInput {
  transcript_path?: string;
  cwd?: string;
}

/**
 * Sends the finished session to ingest. Returns the session id, or null when
 * there is nothing to send or anything fails: a hook must never break exit.
 * With extract, also asks the API to propose memories from it.
 */
export async function sendSession(
  client: ApiClient,
  input: SessionEndInput,
  opts: { extract?: boolean; agent?: string } = {},
): Promise<string | null> {
  try {
    if (!input.transcript_path) return null;
    const transcript = transcriptText(
      readFileSync(input.transcript_path, "utf8"),
    );
    if (!transcript) return null;
    const cwd = input.cwd ?? process.cwd();
    const p = resolveProject(cwd);
    const { id } = (await client.post("/sessions", {
      project: { key: p.key, name: p.name },
      transcript,
      commitSha: headSha(cwd),
      agent: opts.agent ?? "claude-code",
    })) as { id: string };
    if (opts.extract) await client.post(`/sessions/${id}/extract`, {});
    return id;
  } catch {
    return null;
  }
}
