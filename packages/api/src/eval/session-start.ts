import { z } from "zod";
import type { CoreItem } from "../core.js";
import type { ConceptStart } from "../session-start.js";

/** One line the agent would see at session start. */
export interface PayloadLine {
  /** Practices are the same in both versions, so the ship rule leaves them out. */
  kind: "practice" | "memory" | "concept";
  text: string;
}

export interface Payload {
  lines: PayloadLine[];
  /** The block as the session-start hook would inject it. */
  text: string;
}

const isPractice = (i: CoreItem) => i.tags.includes("practice");

function render(sections: { header: string; lines: PayloadLine[] }[]): Payload {
  const shown = sections.filter((s) => s.lines.length > 0);
  return {
    lines: shown.flatMap((s) => s.lines),
    text: shown
      .map((s) => [s.header, ...s.lines.map((l) => `- ${l.text}`)].join("\n"))
      .join("\n"),
  };
}

const PRACTICES =
  "How this user likes to work (from Impression; follow these when they apply):";
const mem = (i: CoreItem): PayloadLine => ({
  kind: "memory",
  text: i.content,
});
const practice = (i: CoreItem): PayloadLine => ({
  kind: "practice",
  text: i.content,
});

/** Today's top-N set, rendered as the hook renders it. */
export function renderTopN(project: string, items: CoreItem[]): Payload {
  return render([
    { header: PRACTICES, lines: items.filter(isPractice).map(practice) },
    {
      header: `Saved memories for ${project} (from Impression; use the impression search tool for more):`,
      lines: items.filter((i) => !isPractice(i)).map(mem),
    },
  ]);
}

/** The concept version: practices, the concept map, then pinned and top memories. */
export function renderConcepts(project: string, s: ConceptStart): Payload {
  return render([
    { header: PRACTICES, lines: s.base.filter(isPractice).map(practice) },
    {
      header: `What Impression knows about ${project}, by topic (use the impression search tool for any of them):`,
      lines: s.map.map((c) => ({
        kind: "concept",
        text: `${c.sub ? "  " : ""}${c.name}: ${c.summary}`,
      })),
    },
    {
      header: `Saved memories for ${project} (from Impression):`,
      lines: [...s.base.filter((i) => !isPractice(i)), ...s.top].map(mem),
    },
  ]);
}

export const JUDGE_SYSTEM = `You judge what a coding agent was told at the start of a session.
You get the session's transcript and two context blocks, A and B, that could have been injected before the first prompt. Each block's lines are numbered.
For every numbered line in both blocks, decide:
- "helped": it bears on work the session actually did and would have saved the agent effort or a mistake.
- "irrelevant": true or harmless, but nothing in the session needed it.
- "misleading": it would have pointed the agent the wrong way in this session.
Topic lines (a topic name and summary) count as helped when they would have sent the agent to search for something the session needed.
Then pick the block that would have set the agent up better for this session, or "tie" when neither is meaningfully better.
Reply with only JSON: {"a":[{"n":1,"label":"helped"}],"b":[...],"better":"A"|"B"|"tie","why":"one sentence"}`;

/** The judge prompt for one session. */
export function judgePrompt(
  transcript: string,
  a: Payload,
  b: Payload,
): string {
  const block = (p: Payload) =>
    p.lines.length
      ? p.lines.map((l, i) => `${i + 1}. ${l.text.trim()}`).join("\n")
      : "(empty)";
  return `<transcript>\n${transcript}\n</transcript>\n\n<block_a>\n${block(a)}\n</block_a>\n\n<block_b>\n${block(b)}\n</block_b>`;
}

const label = z.enum(["helped", "irrelevant", "misleading"]);
const verdictSchema = z.object({
  a: z.array(z.object({ n: z.number().int(), label })),
  b: z.array(z.object({ n: z.number().int(), label })),
  better: z.enum(["A", "B", "tie"]),
  why: z.string().default(""),
});
export type Verdict = z.infer<typeof verdictSchema>;
export type Label = z.infer<typeof label>;

/** The first JSON object in the reply if it is a verdict, else null. */
export function parseVerdict(reply: string): Verdict | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const v = verdictSchema.safeParse(JSON.parse(reply.slice(start, end + 1)));
    return v.success ? v.data : null;
  } catch {
    return null;
  }
}

export interface SideCounts {
  helped: number;
  irrelevant: number;
  misleading: number;
}

/** Label counts for one block, by line kind. Lines the judge skipped count as irrelevant. */
export function countLabels(
  p: Payload,
  labels: { n: number; label: Label }[],
): Record<PayloadLine["kind"], SideCounts> {
  const out = {
    practice: { helped: 0, irrelevant: 0, misleading: 0 },
    memory: { helped: 0, irrelevant: 0, misleading: 0 },
    concept: { helped: 0, irrelevant: 0, misleading: 0 },
  };
  p.lines.forEach((l, i) => {
    const got = labels.find((x) => x.n === i + 1)?.label ?? "irrelevant";
    out[l.kind][got]++;
  });
  return out;
}

export interface SessionResult {
  /** Which real block the judge saw as A. */
  conceptsWere: "A" | "B";
  verdict: Verdict;
  topN: Record<PayloadLine["kind"], SideCounts>;
  concepts: Record<PayloadLine["kind"], SideCounts>;
}

export interface Summary {
  sessions: number;
  conceptWins: number;
  ties: number;
  topNWins: number;
  /** Share of lines judged helpful, practices left out, over all sessions. */
  topNHelpful: number;
  conceptHelpful: number;
  /** The concept version's split: its memory lines and its topic lines. */
  conceptMemoryHelpful: number;
  topicHelpful: number;
  topNMisleading: number;
  conceptMisleading: number;
  pass: boolean;
}

const share = (n: number, d: number) => (d === 0 ? 0 : n / d);
const total = (c: SideCounts) => c.helped + c.irrelevant + c.misleading;
const add = (x: SideCounts, y: SideCounts): SideCounts => ({
  helped: x.helped + y.helped,
  irrelevant: x.irrelevant + y.irrelevant,
  misleading: x.misleading + y.misleading,
});
const ZERO: SideCounts = { helped: 0, irrelevant: 0, misleading: 0 };

/**
 * The ship rule: the concept version wins or ties at least half the sessions,
 * and its share of helpful lines is no lower than top-N's. Practices are the
 * same in both, so they are left out; topic lines count.
 */
export function summarize(results: SessionResult[]): Summary {
  let conceptWins = 0;
  let ties = 0;
  for (const r of results) {
    if (r.verdict.better === "tie") ties++;
    else if (r.verdict.better === r.conceptsWere) conceptWins++;
  }
  const sum = (pick: (r: SessionResult) => SideCounts) =>
    results.reduce((acc, r) => add(acc, pick(r)), ZERO);
  const t = sum((r) => add(r.topN.memory, r.topN.concept));
  const cm = sum((r) => r.concepts.memory);
  const topics = sum((r) => r.concepts.concept);
  const c = add(cm, topics);
  const topNHelpful = share(t.helped, total(t));
  const conceptHelpful = share(c.helped, total(c));
  return {
    sessions: results.length,
    conceptWins,
    ties,
    topNWins: results.length - conceptWins - ties,
    topNHelpful,
    conceptHelpful,
    conceptMemoryHelpful: share(cm.helped, total(cm)),
    topicHelpful: share(topics.helped, total(topics)),
    topNMisleading: share(t.misleading, total(t)),
    conceptMisleading: share(c.misleading, total(c)),
    pass:
      results.length > 0 &&
      conceptWins + ties >= results.length / 2 &&
      conceptHelpful >= topNHelpful,
  };
}
