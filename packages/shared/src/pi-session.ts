/** Reads pi session logs: which memories were injected into which prompts. */

export interface Turn {
  /** Position of the user prompt in the session, counting from 0. */
  index: number;
  /** ISO time of the prompt, when the log has one. */
  at: string | null;
  prompt: string;
  /** Memory texts injected for this prompt (per-prompt search or the session-start core set). */
  injected: string[];
  /** Start of the assistant's first reply text, for judging whether the memory was used. */
  reply: string;
}

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p) => (p?.type === "text" ? String(p.text ?? "") : ""))
          .join("")
      : "";

/** Memory lines from an injected block: every "- " bullet after the header. */
export function injectedMemories(block: string): string[] {
  return block
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

/** Session id and working directory, from the first log line. */
export function sessionHeader(
  jsonl: string,
): { id: string; cwd: string } | null {
  try {
    const first = JSON.parse(jsonl.slice(0, jsonl.indexOf("\n")));
    return first.type === "session" &&
      typeof first.id === "string" &&
      typeof first.cwd === "string"
      ? { id: first.id, cwd: first.cwd }
      : null;
  } catch {
    return null;
  }
}

/** Splits a pi session .jsonl into turns. Injection entries follow the user prompt they belong to. */
export function parseSession(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split("\n")) {
    let e: {
      type?: string;
      timestamp?: string;
      customType?: string;
      content?: unknown;
      message?: { role?: string; content?: unknown };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const last = turns.at(-1);
    if (e.type === "message" && e.message?.role === "user") {
      turns.push({
        index: turns.length,
        at: e.timestamp ?? null,
        prompt: text(e.message.content),
        injected: [],
        reply: "",
      });
    } else if (e.type === "custom_message" && e.customType === "impression") {
      if (last)
        for (const m of injectedMemories(String(e.content ?? "")))
          if (!last.injected.includes(m)) last.injected.push(m);
    } else if (
      e.type === "message" &&
      e.message?.role === "assistant" &&
      last &&
      !last.reply
    ) {
      last.reply = text(e.message.content).slice(0, 300);
    }
  }
  return turns;
}

export interface Report {
  prompts: number;
  withMemories: number;
  /** How many times each memory was injected. */
  counts: Map<string, number>;
}

export function summarize(turns: Turn[]): Report {
  const counts = new Map<string, number>();
  let withMemories = 0;
  for (const t of turns) {
    if (t.injected.length) withMemories++;
    for (const m of new Set(t.injected))
      counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return { prompts: turns.length, withMemories, counts };
}
