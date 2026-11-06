import { expect, test } from "vitest";
import { fakeProviders } from "../test-providers.js";
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
  const scores = (await evalSearch(fakeProviders(), [0.25])).get(0.25);
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
  const ids = new Set(memories.map((m) => m.id));
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
