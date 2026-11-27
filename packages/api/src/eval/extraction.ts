import { parseExtraction, SYSTEM } from "../extract.js";
import type { LlmProvider } from "../providers/types.js";
import { type ExtractionCase, extractionCases } from "./extraction-fixture.js";

export interface CaseResult {
  name: string;
  memories: string[];
  missing: string[][];
  forbidden: string[];
  pass: boolean;
}

/** Runs the extraction prompt on one case and checks wanted and forbidden content. */
export async function runCase(
  llm: LlmProvider,
  c: ExtractionCase,
): Promise<CaseResult> {
  const reply = await llm.complete({
    system: SYSTEM,
    prompt: `Transcript:\n${c.transcript}`,
    maxTokens: 2000,
  });
  const items = parseExtraction(reply);
  const memories = items.map((m) => m.content);
  const has = (text: string, terms: string[]) =>
    terms.every((t) => text.toLowerCase().includes(t.toLowerCase()));
  const practices = items.filter((m) => m.kind === "practice");
  const facts = items.filter((m) => m.kind === "fact");
  const unmatched = (groups: string[][] | undefined, among: string[]) =>
    (groups ?? []).filter((terms) => !among.some((m) => has(m, terms)));
  const missing = [
    ...unmatched(c.want, memories),
    ...unmatched(
      c.practice,
      practices.map((m) => m.content),
    ),
    ...unmatched(
      c.fact,
      facts.map((m) => m.content),
    ),
  ];
  // Practices follow the user everywhere, so a practice labelled a fact (or the reverse) is a miss.
  const expected = (text: string) =>
    !(c.fact ?? []).some((terms) => has(text, terms)) &&
    (c.practice ?? []).some((terms) => has(text, terms))
      ? "practice"
      : "fact";
  const wrongKind = items
    .filter((m) => m.kind !== expected(m.content))
    .map((m) => `${m.kind}: ${m.content}`);
  const forbidden = [
    ...memories.filter((m) => c.avoid.some((re) => re.test(m))),
    ...practices
      .filter((m) => (c.avoidInPractice ?? []).some((re) => re.test(m.content)))
      .map((m) => `practice: ${m.content}`),
    ...wrongKind,
  ];
  return {
    name: c.name,
    memories,
    missing,
    forbidden,
    pass: missing.length === 0 && forbidden.length === 0,
  };
}

export const runExtractionEval = (llm: LlmProvider) =>
  Promise.all(extractionCases.map((c) => runCase(llm, c)));
