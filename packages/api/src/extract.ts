import { z } from "zod";
import type { Db } from "./db/client.js";
import { proposals } from "./db/schema.js";
import type { Providers } from "./providers/index.js";
import { decide, findCandidates } from "./reconcile.js";
import { isEmptyAfterScrub, scrub } from "./scrub.js";

/** Characters of transcript sent to the model. The tail is kept: conclusions come last. */
export const MAX_PROMPT_CHARS = 60_000;
const MAX_CANDIDATES = 15;

const SYSTEM = `You extract durable project knowledge from a coding-session transcript, for a memory that future sessions will read.
Extract only things that will still matter next week: decisions and their reasons, conventions, gotchas and pitfalls, and working commands. Skip task chatter, one-off debugging steps, anything obvious from the code, and anything secret.
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

export interface ExtractInput {
  sessionId: string;
  projectId: string;
  owner: string;
  commitSha: string | null;
  transcript: string;
}

export interface ExtractSummary {
  proposed: number;
  skippedDuplicates: number;
  skippedEmpty: number;
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
    prompt: `Transcript:\n${text}`,
    maxTokens: 2000,
  });
  const summary: ExtractSummary = {
    proposed: 0,
    skippedDuplicates: 0,
    skippedEmpty: 0,
  };

  for (const item of parseExtraction(reply)) {
    const clean = scrub(item.content);
    if (isEmptyAfterScrub(clean.text)) {
      summary.skippedEmpty++;
      continue;
    }
    try {
      const [vec] = await providers.embeddings.embed([clean.text]);
      if (vec) {
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
    await db.insert(proposals).values({
      projectId: input.projectId,
      sessionId: input.sessionId,
      content: clean.text,
      confidence: item.confidence,
      anchors,
    });
    summary.proposed++;
  }
  return summary;
}
