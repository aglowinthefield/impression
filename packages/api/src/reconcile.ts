import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { memories } from "./db/schema.js";
import type { LlmProvider } from "./providers/index.js";

/** Existing memories closer than this (cosine similarity) are shown to the LLM as candidates. */
export const CANDIDATE_MIN_SIMILARITY = 0.4;
const MAX_CANDIDATES = 5;

export type Verdict =
  | { action: "add" }
  | { action: "duplicate"; id: string; merged?: string }
  | { action: "supersede"; ids: string[] };

export interface Candidate {
  id: string;
  content: string;
}

const verdictSchema = z.union([
  z.object({ action: z.literal("add") }),
  z.object({
    action: z.literal("duplicate"),
    id: z.string(),
    merged: z.string().trim().min(1).max(10_000).optional(),
  }),
  z.object({ action: z.literal("supersede"), ids: z.array(z.string()).min(1) }),
]);

const SYSTEM = `You maintain a developer's project memory. A new memory is about to be saved. Compare it with existing memories and decide:
- "duplicate": an existing memory already says the same thing. Give its id. If the new one adds a detail worth keeping, put the combined text in "merged", otherwise omit "merged".
- "supersede": the new memory contradicts or replaces existing ones, so they are now wrong. Give their ids.
- "add": it is a different fact. Related is not the same as duplicate.
When unsure, answer "add". Reply with one JSON object and nothing else:
{"action":"add"} | {"action":"duplicate","id":"...","merged":"..."} | {"action":"supersede","ids":["..."]}`;

export function buildPrompt(content: string, candidates: Candidate[]): string {
  const list = candidates.map((c) => `[${c.id}] ${c.content}`).join("\n");
  return `Existing memories:\n${list}\n\nNew memory:\n${content}`;
}

/** The first JSON object in the reply, if it is a verdict at all. */
function readVerdict(reply: string): Verdict | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = verdictSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Extracts the first JSON object from the reply and checks it against the candidates. Anything off means "add". */
export function parseVerdict(reply: string, candidates: Candidate[]): Verdict {
  const v = readVerdict(reply);
  if (!v) return { action: "add" };
  const known = new Set(candidates.map((c) => c.id));
  if (v.action === "duplicate") return known.has(v.id) ? v : { action: "add" };
  if (v.action === "supersede") {
    const ids = v.ids.filter((id) => known.has(id));
    return ids.length > 0 ? { action: "supersede", ids } : { action: "add" };
  }
  return v;
}

export interface Target {
  scope: "user" | "project";
  projectId: string | null;
  owner: string;
}

/** Active memories in the same scope and project that are close to the new vector. */
export async function findCandidates(
  db: Db,
  target: Target,
  vector: number[],
): Promise<Candidate[]> {
  const literal = JSON.stringify(vector);
  const scopeMatch =
    target.scope === "user"
      ? sql`m.scope = 'user' AND m.owner = ${target.owner}`
      : sql`m.scope = 'project' AND m.owner = ${target.owner} AND m.project_id = ${target.projectId}`;
  const rows = await db.execute<{ id: string; content: string }>(sql`
    SELECT m.id, m.content FROM memories m
    WHERE ${scopeMatch}
      AND m.status IN ('active', 'possibly_stale')
      AND m.embedding IS NOT NULL
      AND 1 - (m.embedding <=> ${literal}::vector) >= ${CANDIDATE_MIN_SIMILARITY}
    ORDER BY m.embedding <=> ${literal}::vector
    LIMIT ${MAX_CANDIDATES}`);
  return rows.map((r) => ({ id: r.id, content: r.content }));
}

/**
 * Asks the LLM what to do with a new memory. Fails open: any error means "add".
 * With `strict`, an LLM error or a reply that isn't a verdict throws instead.
 */
export async function decide(
  llm: LlmProvider,
  content: string,
  candidates: Candidate[],
  opts: { strict?: boolean } = {},
): Promise<Verdict> {
  if (candidates.length === 0) return { action: "add" };
  try {
    const reply = await llm.complete({
      system: SYSTEM,
      prompt: buildPrompt(content, candidates),
      maxTokens: 300,
    });
    if (opts.strict && !readVerdict(reply))
      throw new Error("dedup check gave no verdict");
    return parseVerdict(reply, candidates);
  } catch (err) {
    if (opts.strict) throw err;
    console.error(
      "dedup check failed:",
      err instanceof Error ? err.message : err,
    );
    return { action: "add" };
  }
}

/** Marks old memories as replaced by the new one. They stay as history. */
export async function markSuperseded(db: Db, oldIds: string[], newId: string) {
  await db
    .update(memories)
    .set({ status: "superseded", supersededBy: newId, updatedAt: new Date() })
    .where(and(inArray(memories.id, oldIds), eq(memories.status, "active")));
  await db
    .update(memories)
    .set({ status: "superseded", supersededBy: newId, updatedAt: new Date() })
    .where(
      and(inArray(memories.id, oldIds), eq(memories.status, "possibly_stale")),
    );
}
