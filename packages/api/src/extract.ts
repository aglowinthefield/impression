import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client.js";
import { proposals } from "./db/schema.js";
import { anchorInput, createMemory } from "./memories.js";
import type { Providers } from "./providers/index.js";
import { decide, findCandidates } from "./reconcile.js";
import { isEmptyAfterScrub, scrub } from "./scrub.js";

/** Characters of transcript sent to the model. The tail is kept: conclusions come last. */
export const MAX_PROMPT_CHARS = 60_000;
const MAX_CANDIDATES = 15;

export const SYSTEM = `You extract durable project knowledge from a coding-session transcript, for a memory that future sessions will read.
Extract only things that will still matter next week: decisions and their reasons, conventions, gotchas and pitfalls, and working commands. Skip task chatter, one-off debugging steps, anything obvious from the code, and anything secret.
Only the user's decisions, preferences and corrections are decisions. Do not record the assistant's suggestions, options, plans or offers unless the user accepted them. Do not record progress or status ("X is now live", "tests pass", "committed as abc123"), how the UI currently looks, or an assistant claim the user never confirmed. If the user corrected the assistant, record the correction, not the claim that was corrected.
Do not record rules that come from project instruction files (AGENTS.md, CLAUDE.md, README conventions) or that the assistant read from one, even when the user agrees with them. Those files are already loaded into every session, so a memory repeats them and goes stale when they change. Keep what the files don't say: facts learned while working.
Prefer one consolidated memory over several that restate the same thing.
Each item is one self-contained sentence or two. If a file or symbol is central to it, add an anchor with a repo-relative path and optional symbol.
"confidence" is 0 to 1: how sure you are that it is true, durable and useful.
Reply with one JSON object and nothing else:
{"memories":[{"content":"...","confidence":0.8,"anchors":[{"path":"src/x.ts","symbol":"fn"}]}]}
If nothing is worth keeping, reply {"memories":[]}.`;

const itemSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  anchors: z
    .array(
      z.object({
        path: z.string().trim().min(1),
        symbol: z.string().trim().min(1).nullish(),
      }),
    )
    .default([]),
});

export type Extracted = z.infer<typeof itemSchema>;

/** Parses the model reply leniently: bad items are dropped, a bad reply gives []. */
export function parseExtraction(reply: string): Extracted[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (raw as { memories?: unknown })?.memories;
  if (!Array.isArray(list)) return [];
  const out: Extracted[] = [];
  for (const item of list.slice(0, MAX_CANDIDATES)) {
    const p = itemSchema.safeParse(item);
    if (p.success) out.push(p.data);
  }
  return out;
}

/** A candidate this close to a pending or rejected proposal is treated as the same one. */
export const REPROPOSAL_MIN_SIMILARITY = 0.9;

export interface ExtractInput {
  sessionId: string;
  projectId: string;
  projectKey: string;
  /** Proposals at or above this confidence become memories right away. Null turns auto-accept off. */
  autoAcceptConfidence: number | null;
  owner: string;
  commitSha: string | null;
  transcript: string;
  /** Project instruction files the agent already loads. Used only to avoid restating them. */
  instructions?: string;
}

export interface ExtractSummary {
  proposed: number;
  skippedDuplicates: number;
  skippedEmpty: number;
  /** Skipped because a pending or rejected proposal already says it. */
  skippedRepeats: number;
  autoAccepted: number;
}

/**
 * Turns a session transcript into stored proposals. Each candidate is scrubbed,
 * then compared with existing project memories: ones the project already knows
 * are dropped. Anchors without a session commit are dropped, since they can't
 * be verified later.
 */
export async function extractProposals(
  db: Db,
  providers: Providers,
  input: ExtractInput,
): Promise<ExtractSummary> {
  const text = input.transcript.slice(-MAX_PROMPT_CHARS);
  const reply = await providers.llm.complete({
    system: SYSTEM,
    prompt: input.instructions
      ? `Project instructions, already loaded into every session. Do not record anything they already say:\n${input.instructions}\n\nTranscript:\n${text}`
      : `Transcript:\n${text}`,
    maxTokens: 2000,
  });
  const summary: ExtractSummary = {
    proposed: 0,
    skippedDuplicates: 0,
    skippedEmpty: 0,
    skippedRepeats: 0,
    autoAccepted: 0,
  };

  for (const item of parseExtraction(reply)) {
    const clean = scrub(item.content);
    if (isEmptyAfterScrub(clean.text)) {
      summary.skippedEmpty++;
      continue;
    }
    let vec: number[] | null = null;
    try {
      vec = (await providers.embeddings.embed([clean.text]))[0] ?? null;
      if (vec) {
        const literal = JSON.stringify(vec);
        const repeats = await db.execute(sql`
          SELECT 1 FROM proposals
          WHERE project_id = ${input.projectId}
            AND status IN ('pending', 'rejected')
            AND embedding IS NOT NULL
            AND 1 - (embedding <=> ${literal}::vector) >= ${REPROPOSAL_MIN_SIMILARITY}
          LIMIT 1`);
        if (repeats.length > 0) {
          summary.skippedRepeats++;
          continue;
        }
        const candidates = await findCandidates(
          db,
          { scope: "project", projectId: input.projectId, owner: input.owner },
          vec,
        );
        const verdict = await decide(providers.llm, clean.text, candidates);
        if (verdict.action === "duplicate") {
          summary.skippedDuplicates++;
          continue;
        }
      }
    } catch (err) {
      console.error(
        "extraction dedup failed:",
        err instanceof Error ? err.message : err,
      );
    }
    const sha = input.commitSha;
    const anchors = sha
      ? item.anchors
          .filter(
            (a) => !a.path.startsWith("/") && !a.path.split("/").includes(".."),
          )
          .map((a) => ({
            path: a.path.replace(/^(\.\/)+/, ""),
            ...(a.symbol ? { symbol: a.symbol } : {}),
            commitSha: sha,
          }))
      : [];
    const [proposal] = await db
      .insert(proposals)
      .values({
        projectId: input.projectId,
        sessionId: input.sessionId,
        content: clean.text,
        confidence: item.confidence,
        embedding: vec,
        anchors,
      })
      .returning();
    if (
      proposal &&
      input.autoAcceptConfidence !== null &&
      item.confidence >= input.autoAcceptConfidence
    ) {
      await acceptProposal(db, providers, proposal.id, input.owner, {
        projectKey: input.projectKey,
        sessionId: input.sessionId,
      });
      summary.autoAccepted++;
    }
    summary.proposed++;
  }
  return summary;
}

/**
 * Turns a pending proposal into a project memory, optionally with edited text.
 * Goes through the normal create path, so it is scrubbed and deduped again.
 * Returns null if the proposal isn't pending.
 */
export async function acceptProposal(
  db: Db,
  providers: Providers,
  id: string,
  principal: string,
  opts: { projectKey: string; sessionId?: string | null; content?: string },
) {
  const [claimed] = await db
    .update(proposals)
    .set({ status: "accepted" })
    .where(and(eq(proposals.id, id), eq(proposals.status, "pending")))
    .returning();
  if (!claimed) return null;
  const anchors = z.array(anchorInput).catch([]).parse(claimed.anchors);
  const result = await createMemory(db, providers, principal, {
    scope: "project",
    project: { key: opts.projectKey },
    content: opts.content ?? claimed.content,
    confidence: claimed.confidence,
    agent: "extraction",
    sessionId: opts.sessionId ?? claimed.sessionId ?? undefined,
    dedup: true,
    anchors,
  });
  if (result.status === 422) {
    await db
      .update(proposals)
      .set({ status: "pending" })
      .where(eq(proposals.id, id));
    return result;
  }
  const memoryId = (result.body as { id: string }).id;
  await db.update(proposals).set({ memoryId }).where(eq(proposals.id, id));
  return result;
}
