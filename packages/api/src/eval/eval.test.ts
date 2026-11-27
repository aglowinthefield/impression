import { describe, expect, test } from "vitest";
import type { LlmProvider } from "../providers/types.js";
import { fakeProviders } from "../test-providers.js";
import { runCase } from "./extraction.js";
import { extractionCases } from "./extraction-fixture.js";
import { memories, offTopic, pairs, queries } from "./fixture.js";
import { noMemoryPrompts, prompts } from "./prompts-fixture.js";
import { evalPairs, evalPrompts, evalSearch } from "./run.js";

test("fixture is well formed", () => {
  const ids = new Set(memories.map((m) => m.id));
  expect(ids.size).toBe(memories.length);
  for (const { expect: e } of queries) expect(ids.has(e)).toBe(true);
  expect(offTopic.length).toBeGreaterThan(0);
  expect(pairs.paraphrase.length).toBe(pairs.unrelated.length);
});

// The fake bag-of-words embedder is free and deterministic, so this catches ranking
// regressions in CI. Real-model numbers come from `pnpm --filter @impression/api eval`.
test("search ranking holds its baseline with the fake embedder", async () => {
  const scores = (await evalSearch(fakeProviders(), [0.1])).get(0.1);
  expect(scores?.hitAt3).toBeGreaterThanOrEqual(0.6);
  expect(scores?.mrr).toBeGreaterThanOrEqual(0.5);
  expect(scores?.offTopicHits).toBeLessThanOrEqual(0.6);
});

test("paraphrases score above unrelated pairs", async () => {
  const p = await evalPairs(fakeProviders());
  const avg = (xs: number[] | undefined) =>
    (xs ?? []).reduce((a, b) => a + b, 0) / (xs?.length ?? 1);
  expect(avg(p.paraphrase)).toBeGreaterThan(avg(p.unrelated));
});

test("prompt fixture only expects memories that exist", () => {
  const ids = new Set<string>(memories.map((m) => m.id));
  for (const { expect: e } of prompts)
    for (const id of e) expect(ids.has(id)).toBe(true);
  expect(noMemoryPrompts.length).toBeGreaterThan(0);
});

test("realistic prompts find something and the floor trims what is injected", async () => {
  const scores = await evalPrompts(fakeProviders(), [0, 0.4]);
  expect(scores.get(0)?.recallAt5).toBeGreaterThan(0.3);
  expect(scores.get(0.4)?.injectedPerPrompt).toBeLessThan(
    scores.get(0)?.injectedPerPrompt ?? 0,
  );
});

test("strict search injects no more than a normal one, and never more per prompt", async () => {
  const normal = await evalPrompts(fakeProviders(), [0.1]);
  const strict = await evalPrompts(fakeProviders(), [0.2]);
  expect(strict.get(0.2)?.injectedPerPrompt).toBeLessThanOrEqual(
    normal.get(0.1)?.injectedPerPrompt ?? 0,
  );
});

describe("extraction eval scoring", () => {
  const llm = (memories: unknown[]): LlmProvider => ({
    model: "fake",
    complete: async () => JSON.stringify({ memories }),
  });
  const byName = (name: string) => {
    const c = extractionCases.find((x) => x.name === name);
    if (!c) throw new Error(`no case ${name}`);
    return c;
  };
  const split = byName("repo specifics split off a practice into a fact");
  const practice = {
    kind: "practice",
    otherRepos: true,
    content:
      "When doing a /nitpick design session, run the app against a fork of production data.",
    confidence: 0.9,
  };
  const fact = {
    kind: "fact",
    content:
      "In silk, /nitpick sessions on DMs run on ports 3100 and 3101, since the usual dev ports are taken.",
    confidence: 0.9,
  };

  test("a practice without the ports plus a fact with them passes", async () => {
    expect((await runCase(llm([practice, fact]), split)).pass).toBe(true);
  });

  test("ports left in the practice, or no fact, fail", async () => {
    const leaky = {
      ...practice,
      content: `${practice.content} For DMs in silk use ports 3100/3101.`,
    };
    expect((await runCase(llm([leaky]), split)).pass).toBe(false);
    expect((await runCase(llm([leaky, fact]), split)).pass).toBe(false);
    expect((await runCase(llm([practice]), split)).pass).toBe(false);
    // Only a fact: the practice is missing.
    expect((await runCase(llm([fact]), split)).pass).toBe(false);
  });

  test("the chore case passes only when nothing is kept", async () => {
    const chore = byName("chore on the user's machine is not kept");
    expect((await runCase(llm([]), chore)).pass).toBe(true);
    const todo = {
      content:
        "$DEV_VAULT points to a stale path ~/Documents/Dev; update it to ~/Documents/somewhere.garden in shell config.",
      confidence: 0.9,
    };
    expect((await runCase(llm([todo]), chore)).pass).toBe(false);
  });
});
