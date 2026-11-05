import { createProviders } from "../providers/index.js";
import { runExtractionEval } from "./extraction.js";

// Real LLM (LLM_PROVIDER, plus its key). `pnpm --filter @impression/api eval:extract`
const { llm } = createProviders();
console.log(`model: ${llm.model}\n`);
const results = await runExtractionEval(llm);
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  for (const m of r.memories) console.log(`        kept: ${m}`);
  for (const t of r.missing) console.log(`        missing: ${t.join(" + ")}`);
  for (const f of r.forbidden) console.log(`        should not keep: ${f}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} cases passed`);
process.exit(passed === results.length ? 0 : 1);
