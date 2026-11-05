import { createProviders } from "../providers/index.js";
import { CANDIDATE_MIN_SIMILARITY } from "../reconcile.js";
import { DEFAULT_MIN_SIMILARITY } from "../search.js";
import { evalPairs, evalSearch } from "./run.js";

// Real providers: needs OPENAI_API_KEY. Run with `pnpm --filter @impression/api eval`.
const providers = createProviders();
const mins = [0, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
const rows = await evalSearch(providers, mins);
console.log(`model: ${providers.embeddings.model}`);
console.log("minSimilarity  hit@3  MRR   off-topic-with-results");
for (const [min, s] of rows) {
  const mark = min === DEFAULT_MIN_SIMILARITY ? " <- default" : "";
  console.log(
    `${min.toFixed(2).padEnd(14)} ${s.hitAt3.toFixed(2)}   ${s.mrr.toFixed(2)}  ${s.offTopicHits.toFixed(2)}${mark}`,
  );
}
const p = await evalPairs(providers);
console.log(
  `\ndedup pair cosine similarity (candidate floor ${CANDIDATE_MIN_SIMILARITY})`,
);
for (const [group, sims] of Object.entries(p)) {
  const s = [...sims].sort((a, b) => a - b);
  console.log(
    `${group.padEnd(12)} min ${s[0]?.toFixed(2)}  max ${s.at(-1)?.toFixed(2)}  [${sims.map((x) => x.toFixed(2)).join(" ")}]`,
  );
}
