import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Access, upsertProject } from "./access.js";
import type { Db } from "./db/client.js";
import { proposals } from "./db/schema.js";
import { anchorInput, createMemory } from "./memories.js";
import type { Providers } from "./providers/index.js";
import { isEmptyAfterScrub, scrub } from "./scrub.js";
import { getExtractionFloor } from "./settings.js";

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

/** Added to SYSTEM when the session touched more than one repo. */
export const PROJECTS_SYSTEM = `This session touched more than one repository; the prompt lists them.
Give each fact a "project": the key of the repository it is about, copied exactly from that list, for example {"kind":"fact","project":"github.com/owner/repo","content":"...","confidence":0.8,"anchors":[]}.
Edits and commands in a repository show work happened there. A repository that was only read is usually reference material: pick it only when the fact is clearly about that repository's own code or setup.
If you are not sure which repository a fact is about, use the session's own project.
Anchor paths are relative to the root of the repository you picked, never to another one. Leave an anchor out if you are unsure which repository its file is in.
Practices follow the user, so they need no project.`;

/** Repos a client may send with a session, beyond the one it ran in. */
export const MAX_PROJECT_CANDIDATES = 10;

export const candidateSchema = z.object({
  key: z.string().trim().min(1).max(300),
  name: z.string().trim().min(1).max(200).optional(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional(),
  /** Edits, writes and commands run in the repo. */
  edits: z.number().int().min(0).catch(0).default(0),
  /** Read-only hits. */
  reads: z.number().int().min(0).catch(0).default(0),
  /** Repo-relative files the session touched, used to check anchors. */
  files: z
    .array(z.string().trim().min(1).max(500))
    .max(50)
    .catch([])
    .default([]),
});

export type SessionCandidate = z.infer<typeof candidateSchema>;

export const candidatesSchema = z
  .array(candidateSchema)
  .max(MAX_PROJECT_CANDIDATES);

const itemSchema = z.object({
  /** A practice is how the user likes work done. It follows them across projects. */
  kind: z.enum(["fact", "practice"]).catch("fact").default("fact"),
  otherRepos: z.boolean().catch(false).default(false),
  /** Key of the repo a fact is about, from the candidate list. Checked against it later. */
  project: z.string().trim().min(1).nullish().catch(undefined),
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

/** A candidate this close to a proposal a person rejected is treated as the same one. */
export const REPROPOSAL_MIN_SIMILARITY = 0.9;

export interface ExtractInput {
  sessionId: string;
  projectId: string;
  projectKey: string;
  owner: string;
  commitSha: string | null;
  transcript: string;
  /** Project instruction files the agent already loads. Used only to avoid restating them. */
  instructions?: string;
  /** Repos the session's tool calls touched, from the client. */
  candidates?: SessionCandidate[];
  /** The request's access. A fact only goes to another repo the person can reach. */
  access?: Access;
}

/** A repo a memory can be filed under. The session's own project comes first. */
interface Target {
  key: string;
  name: string;
  headSha: string | null;
  edits: number;
  reads: number;
  files: string[];
  /** Resolved lazily; null when the person can't reach the repo. */
  projectId?: string | null;
}

/**
 * The repos extraction may choose from, or [] when the session never left its
 * own project, in which case extraction works exactly as before.
 */
export function projectTargets(input: ExtractInput): Target[] {
  const seen = new Set([input.projectKey.toLowerCase()]);
  const others: Target[] = [];
  for (const c of input.candidates ?? []) {
    const k = c.key.toLowerCase();
    if (c.key.startsWith("path:") || seen.has(k)) continue;
    seen.add(k);
    others.push({
      key: c.key,
      name: c.name ?? c.key.split("/").pop() ?? c.key,
      headSha: c.headSha ?? null,
      edits: c.edits,
      reads: c.reads,
      files: c.files,
    });
  }
  if (others.length === 0) return [];
  const own = input.candidates?.find(
    (c) => c.key.toLowerCase() === input.projectKey.toLowerCase(),
  );
  return [
    {
      key: input.projectKey,
      name: own?.name ?? input.projectKey.split("/").pop() ?? input.projectKey,
      headSha: input.commitSha ?? own?.headSha ?? null,
      edits: own?.edits ?? 0,
      reads: own?.reads ?? 0,
      files: own?.files ?? [],
      projectId: input.projectId,
    },
    ...others,
  ];
}

const PROMPT_FILES = 20;

function targetsPrompt(targets: Target[]): string {
  const rows = targets.map((t, i) => {
    const files = t.files.slice(0, PROMPT_FILES);
    return `- ${t.key}${i === 0 ? " (the session's own project)" : ""}: ${t.edits} edits or commands, ${t.reads} reads${files.length ? `; files: ${files.join(", ")}` : ""}`;
  });
  return `Projects this session touched:\n${rows.join("\n")}`;
}

/**
 * Whether an anchor path belongs to the picked repo. Another repo must have
 * had that file touched in the session. The session's project keeps the old
 * benefit of the doubt, unless the file is one another repo touched instead.
 */
function anchorFits(targets: Target[], target: Target, path: string): boolean {
  if (targets.length === 0) return true;
  const touched = (t: Target) =>
    t.files.some((f) => f === path || f.startsWith(`${path}/`));
  if (touched(target)) return true;
  if (target !== targets[0]) return false;
  return !targets.some((t) => t !== target && touched(t));
}

/** The candidate the model picked, or the session's project for a missing or made-up key. */
function pickTarget(targets: Target[], key: string | null | undefined) {
  const k = key?.toLowerCase();
  return (
    targets.find((t) => t.key === key) ??
    targets.find((t) => t.key.toLowerCase() === k) ??
    targets[0]
  );
}

export interface ExtractSummary {
  /** New memories. */
  accepted: number;
  /** Already known: matched or merged into an active memory. */
  skippedDuplicates: number;
  skippedEmpty: number;
  /** Skipped because a person rejected the same thing before. */
  skippedRepeats: number;
  /** Below the owner's extraction floor. */
  skippedBelowFloor: number;
  /** About a repo the person can't reach, so dropped rather than filed elsewhere. */
  skippedNoAccess: number;
}

/**
 * Turns a session transcript into memories. Each candidate at or above the
 * owner's confidence floor is scrubbed, recorded as a proposal and accepted,
 * which dedups it against active memories. Anchors without a session commit are
 * dropped, since they can't be verified later. When the session touched other
 * repos, each fact goes to the one the model picks from that list.
 */
export async function extractProposals(
  db: Db,
  providers: Providers,
  input: ExtractInput,
): Promise<ExtractSummary> {
  const text = input.transcript.slice(-MAX_PROMPT_CHARS);
  const targets = projectTargets(input);
  const parts = [
    input.instructions
      ? `Project instructions, already loaded into every session. Do not record anything they already say:\n${input.instructions}`
      : "",
    targets.length ? targetsPrompt(targets) : "",
    `Transcript:\n${text}`,
  ];
  const reply = await providers.llm.complete({
    system: targets.length ? `${SYSTEM}\n${PROJECTS_SYSTEM}` : SYSTEM,
    prompt: parts.filter(Boolean).join("\n\n"),
    maxTokens: 2000,
  });
  const floor = await getExtractionFloor(db, input.owner);
  const summary: ExtractSummary = {
    accepted: 0,
    skippedDuplicates: 0,
    skippedEmpty: 0,
    skippedRepeats: 0,
    skippedBelowFloor: 0,
    skippedNoAccess: 0,
  };
  const session: Target = targets[0] ?? {
    key: input.projectKey,
    name: input.projectKey,
    headSha: input.commitSha,
    edits: 0,
    reads: 0,
    files: [],
    projectId: input.projectId,
  };

  for (const item of parseExtraction(reply)) {
    if (item.confidence < floor) {
      summary.skippedBelowFloor++;
      continue;
    }
    const clean = scrub(item.content);
    if (isEmptyAfterScrub(clean.text)) {
      summary.skippedEmpty++;
      continue;
    }
    const practice = item.kind === "practice";
    // Practices are user-scoped, so the session's project only records where they came from.
    const target = practice
      ? session
      : (pickTarget(targets, item.project) ?? session);
    if (target.projectId === undefined) {
      const p = input.access
        ? await upsertProject(db, input.access, {
            key: target.key,
            name: target.name,
          })
        : null;
      target.projectId = p?.id ?? null;
    }
    const projectId = target.projectId;
    if (!projectId) {
      summary.skippedNoAccess++;
      continue;
    }
    let vec: number[] | null = null;
    try {
      vec = (await providers.embeddings.embed([clean.text]))[0] ?? null;
      if (vec && (await isRepeat(db, input.owner, projectId, practice, vec))) {
        summary.skippedRepeats++;
        continue;
      }
    } catch (err) {
      console.error(
        "extraction repeat check failed:",
        err instanceof Error ? err.message : err,
      );
    }
    // The recheck reads the anchor at this commit, so it must be the picked repo's HEAD.
    const sha = target.headSha;
    // A practice follows the user to other repos, so it has nothing to anchor to.
    const anchors =
      sha && !practice
        ? item.anchors
            .filter(
              (a) =>
                !a.path.startsWith("/") && !a.path.split("/").includes(".."),
            )
            .map((a) => ({
              path: a.path.replace(/^(\.\/)+/, ""),
              ...(a.symbol ? { symbol: a.symbol } : {}),
              commitSha: sha,
            }))
            .filter((a) => anchorFits(targets, target, a.path))
        : [];
    const [proposal] = await db
      .insert(proposals)
      .values({
        projectId,
        sessionId: input.sessionId,
        content: clean.text,
        scope: practice ? "user" : "project",
        tags: practice ? [PRACTICE_TAG] : [],
        confidence: item.confidence,
        embedding: vec,
        anchors,
      })
      .returning();
    if (!proposal) continue;
    const outcome = await acceptProposal(
      db,
      providers,
      proposal.id,
      input.owner,
      {
        projectKey: target.key,
        sessionId: input.sessionId,
        embedding: vec,
      },
    );
    if (outcome === "created" || outcome === "superseded") summary.accepted++;
    else if (outcome === "duplicate" || outcome === "merged")
      summary.skippedDuplicates++;
    else if (outcome === "empty") summary.skippedEmpty++;
  }
  return summary;
}

/**
 * Whether the candidate is something the owner already turned down: a proposal
 * a person rejected in review, or an extracted memory they retired. Facts are
 * checked within the project; practices follow the user, so across projects.
 */
async function isRepeat(
  db: Db,
  owner: string,
  projectId: string,
  practice: boolean,
  vec: number[],
): Promise<boolean> {
  const literal = JSON.stringify(vec);
  const close = (col: string) =>
    sql`${sql.raw(col)} IS NOT NULL AND 1 - (${sql.raw(col)} <=> ${literal}::vector) >= ${REPROPOSAL_MIN_SIMILARITY}`;
  // Rejections from the old review queue still say "don't keep this".
  const rejected = await db.execute(sql`
    SELECT 1 FROM proposals
    WHERE ${practice ? sql`TRUE` : sql`project_id = ${projectId}`}
      AND session_id IN (SELECT id FROM sessions WHERE owner = ${owner})
      AND status = 'rejected'
      AND reviewed_at IS NOT NULL
      AND ${close("embedding")}
    LIMIT 1`);
  if (rejected.length > 0) return true;
  const retired = await db.execute(sql`
    SELECT 1 FROM memories
    WHERE owner = ${owner}
      AND ${practice ? sql`scope = 'user'` : sql`project_id = ${projectId}`}
      AND agent = 'extraction'
      AND status = 'retired'
      AND ${close("embedding")}
    LIMIT 1`);
  return retired.length > 0;
}

export type AcceptOutcome =
  | "created"
  | "superseded"
  | "duplicate"
  | "merged"
  | "empty";

/**
 * Turns a pending proposal into a memory. Goes through the normal create path,
 * so it is scrubbed and deduped against active memories again. Returns null if
 * the proposal isn't pending. A proposal with nothing left after scrubbing is
 * marked rejected, since no one reviews it. If storing the memory throws, the
 * proposal goes back to pending before the error is rethrown.
 */
export async function acceptProposal(
  db: Db,
  providers: Providers,
  id: string,
  principal: string,
  opts: {
    projectKey: string;
    sessionId?: string | null;
    /** Throw rather than add when the dedup check can't run. */
    requireDedup?: boolean;
    /** The proposal content's vector, if the caller already has it. */
    embedding?: number[] | null;
  },
): Promise<AcceptOutcome | null> {
  const [claimed] = await db
    .update(proposals)
    .set({ status: "accepted" })
    .where(and(eq(proposals.id, id), eq(proposals.status, "pending")))
    .returning();
  if (!claimed) return null;
  const user = claimed.scope === "user";
  // A user-scoped memory isn't tied to a repo, so its anchors would go stale.
  const anchors = user
    ? []
    : z.array(anchorInput).catch([]).parse(claimed.anchors);
  let result: Awaited<ReturnType<typeof createMemory>>;
  try {
    result = await createMemory(
      db,
      providers,
      principal,
      {
        scope: user ? "user" : "project",
        // A user-scoped memory follows the person, so it carries no project.
        project: user ? undefined : { key: opts.projectKey },
        tags: claimed.tags,
        content: claimed.content,
        confidence: claimed.confidence,
        agent: "extraction",
        sessionId: opts.sessionId ?? claimed.sessionId ?? undefined,
        dedup: true,
        anchors,
      },
      undefined,
      { requireDedup: opts.requireDedup, embedding: opts.embedding },
    );
  } catch (err) {
    await db
      .update(proposals)
      .set({ status: "pending", memoryId: null })
      .where(eq(proposals.id, id));
    throw err;
  }
  if (result.status === 422) {
    await db
      .update(proposals)
      .set({ status: "rejected" })
      .where(eq(proposals.id, id));
    return "empty";
  }
  const body = result.body as { id: string; outcome?: string };
  await db
    .update(proposals)
    .set({ memoryId: body.id })
    .where(eq(proposals.id, id));
  return body.outcome === "duplicate" ||
    body.outcome === "merged" ||
    body.outcome === "superseded"
    ? body.outcome
    : "created";
}
