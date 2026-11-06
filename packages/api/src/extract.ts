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
/** Tag on memories that record how the user likes work done. */
export const PRACTICE_TAG = "practice";

export const SYSTEM = `You extract durable project knowledge from a coding-session transcript, for a memory that future sessions will read.
Be strict. Most sessions have nothing worth keeping, and an empty list is the usual right answer. Return at most 3 facts even for a long session: pick the ones that matter most.
Keep only what will still be true and useful next month, and that a developer could not get by reading the code: decisions with their reasons, conventions, gotchas, working commands, and the user's stated preferences.
Only the user's decisions, preferences and corrections are decisions. Do not record the assistant's suggestions, options, plans or offers unless the user accepted them. A user who moves on, changes the subject or says "fine" has not accepted anything. If the user corrected the assistant, record the correction, not the claim that was corrected.
Never record any of these:
- Findings, audit results, review comments, gaps, bugs, risks or to-do lists the assistant produced, even when they cite files and lines. They are work items, not knowledge.
- Status or progress: what was built, deployed, merged or fixed, what is next, what is not done yet, test counts, commit hashes, URLs and ids of things just created.
- Descriptions of how the product, UI, config or setup works or is currently set up, even if the user asked about them. The code, docs and settings files already say so.
- Snapshots that will change: counts, sizes, costs, prices, timings, dates, how many of something exist, how the UI currently looks, what a file contains right now.
- Explanations of how code works, including answers to the user's "how does X work" questions. A reader gets these from the code. Keep an explanation only when it states a trap that would surprise someone, and a list of implementation details is never a trap.
- One-off run parameters, such as "run 200 cards first".
- Rules from project instruction files (AGENTS.md, CLAUDE.md, README conventions), or that the assistant read from one, even when the user agrees. Those files are already loaded into every session.
- Anything secret.
A user's instruction on how to build something ("use deterministic ids so retries don't double count", "keep it behind a gate") is a decision with a reason: keep it, without the surrounding task.
Before keeping an item, ask: would a new teammate be glad to have been told this a month from now? If not, drop it.
Prefer one consolidated memory over several that restate the same thing.
Each item is one self-contained sentence or two. If a file or symbol is central to it, add an anchor with a repo-relative path and optional symbol.
"confidence" is 0 to 1: how sure you are that it is true, durable and useful.
Practices are the exception to "project knowledge": they are how this user wants work done, in any project, whatever the repo or stack. Mark them "kind":"practice".
First check what the rule is about. If it is about this repo's code, commands, config or tools ("always run db:reembed after changing the embedding model", "use pnpm here"), it is a fact, even when the user says "always". Only a rule about the user's own way of working, which they would want in a different repo too, can be a practice ("always open a PR instead of pushing to main", "run design sessions against production data").
Then keep a practice only when the user:
- states it as a standing rule ("always", "never", "from now on", "every time", "make sure to"), or
- corrects the assistant for doing it a different way, or
- asks for the same thing again after having asked before (the transcript shows it was repeated).
Write a practice as an instruction with its trigger and the reason if the user gave one: "When doing a /nitpick design session, run the app against a fork of production data, so the design is judged on real content." Name the trigger (a command, a kind of task, a tool) so a later session can tell when it applies. A request for one thing right now ("run the tests", "make that button blue") is not a practice, even if phrased as a demand. Practices don't count toward the limit of 3, but at most 2 per session.
Everything above still applies to practices: never one the assistant invented, and never one the assistant quoted or paraphrased from AGENTS.md, CLAUDE.md or another instruction file. If the user only confirms a rule the assistant just read out ("yes, always"), that rule is already loaded in every session, so drop it.
Reply with one JSON object and nothing else:
{"memories":[{"kind":"fact","otherRepos":false,"content":"...","confidence":0.8,"anchors":[{"path":"src/x.ts","symbol":"fn"}]}]}
Use "kind":"fact" for everything that is not a practice. "otherRepos" is true when the rule is about the user's own workflow (how they run a kind of session, review, git, shipping, testing, a slash command they use) and would hold in any of their projects, such as "run /nitpick design sessions against forks of production data". It is false when the rule is about this repo's own code, commands or config. A practice needs true.
If nothing is worth keeping, reply {"memories":[]}.`;

const itemSchema = z.object({
  /** A practice is how the user likes work done. It follows them across projects. */
  kind: z.enum(["fact", "practice"]).catch("fact").default("fact"),
  otherRepos: z.boolean().catch(false).default(false),
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
    // A "practice" that only makes sense in this repo is a fact, and must not leak to other projects.
    if (p.success)
      out.push({
        ...p.data,
        kind:
          p.data.kind === "practice" && p.data.otherRepos ? "practice" : "fact",
      });
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
            AND session_id IN (SELECT id FROM sessions WHERE owner = ${input.owner})
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
          {
            scope: item.kind === "practice" ? "user" : "project",
            projectId: input.projectId,
            owner: input.owner,
          },
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
        scope: item.kind === "practice" ? "user" : "project",
        tags: item.kind === "practice" ? [PRACTICE_TAG] : [],
        confidence: item.confidence,
        embedding: vec,
        anchors,
      })
      .returning();
    if (
      proposal &&
      input.autoAcceptConfidence !== null &&
      // A practice changes every future session, so a person always reviews it.
      item.kind === "fact" &&
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
    scope: claimed.scope === "user" ? "user" : "project",
    // A user-scoped memory follows the person, so it carries no project.
    project: claimed.scope === "user" ? undefined : { key: opts.projectKey },
    tags: claimed.tags,
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
