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
  const memories = parseExtraction(reply).map((m) => m.content);
  const missing = c.want.filter(
    (terms) =>
      !memories.some((m) =>
        terms.every((t) => m.toLowerCase().includes(t.toLowerCase())),
      ),
  );
  const forbidden = memories.filter((m) => c.avoid.some((re) => re.test(m)));
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
