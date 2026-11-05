import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ApiClient,
  parseSession,
  resolveProject,
  sessionHeader,
} from "@impression/shared";

const BATCH = 200;

export const defaultSessionsDir = () =>
  join(homedir(), ".pi", "agent", "sessions");

interface PushedTurn {
  project: { key: string; name?: string };
  agentSessionId: string;
  turnIndex: number;
  prompt: string;
  reply: string;
  injected: string[];
  at: string | null;
}

/** Reads pi session logs and uploads every prompt with the memories injected for it. */
export async function pushEvalTurns(
  client: ApiClient,
  opts: { dir?: string; match?: string } = {},
): Promise<string> {
  const dir = opts.dir ?? defaultSessionsDir();
  let folders: string[];
  try {
    folders = readdirSync(dir);
  } catch {
    return `No pi sessions found in ${dir}`;
  }
  const turns: PushedTurn[] = [];
  let sessionCount = 0;
  for (const folder of folders) {
    let files: string[];
    try {
      files = readdirSync(join(dir, folder)).filter((f) =>
        f.endsWith(".jsonl"),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const raw = readFileSync(join(dir, folder, file), "utf8");
      const head = sessionHeader(raw);
      if (!head || (opts.match && !head.cwd.includes(opts.match))) continue;
      const project = resolveProject(head.cwd);
      const parsed = parseSession(raw);
      if (parsed.length === 0) continue;
      sessionCount++;
      for (const t of parsed)
        turns.push({
          project: { key: project.key, name: project.name },
          agentSessionId: head.id,
          turnIndex: t.index,
          prompt: t.prompt.slice(0, 20_000),
          reply: t.reply,
          injected: t.injected,
          at: t.at,
        });
    }
  }
  for (let i = 0; i < turns.length; i += BATCH)
    await client.post("/evals/turns", { turns: turns.slice(i, i + BATCH) });
  const withMemories = turns.filter((t) => t.injected.length > 0).length;
  return `Pushed ${turns.length} prompts from ${sessionCount} sessions (${withMemories} had memories injected). Rate them in the web UI, Evals tab.`;
}
