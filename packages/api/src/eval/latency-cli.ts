import { createApp } from "../app.js";
import { createToken } from "../auth.js";
import { EMBEDDING_DIM, memories, projects } from "../db/schema.js";
import { createProviders } from "../providers/index.js";
import { createTestDb } from "../test-db.js";
import { memories as fixtureMemories } from "./fixture.js";
import { noMemoryPrompts, prompts } from "./prompts-fixture.js";

// Real embeddings need OPENAI_API_KEY. Run with `pnpm --filter @impression/api eval:latency [sizes...]`.
// Splits what the per-prompt hook waits on into the embedding call (network, your provider)
// and the search itself (database and ranking) at growing memory counts.
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
if (sizes.length === 0) sizes.push(1_000, 10_000);

const ms = (n: number) => `${n.toFixed(0)} ms`;
function pct(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) =>
    s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? 0 };
}

const providers = createProviders();
const queries = [...prompts.map((p) => p.q), ...noMemoryPrompts];

// 1. The embedding call alone, one prompt at a time like the hook does it.
const embedTimes: number[] = [];
const vectors: number[][] = [];
for (const q of queries) {
  const t0 = performance.now();
  const [v] = await providers.embeddings.embed([q]);
  embedTimes.push(performance.now() - t0);
  vectors.push(v as number[]);
}
const e = pct(embedTimes.slice(1)); // the first call pays connection setup
console.log(
  `embedding (${providers.embeddings.model}): p50 ${ms(e.p50)}  p95 ${ms(e.p95)}  max ${ms(e.max)}  first ${ms(embedTimes[0] ?? 0)}`,
);

// 2. Search with the embedding replayed from memory, so only database + ranking is timed.
let replay = 0;
const replayProviders = {
  ...providers,
  embeddings: {
    model: providers.embeddings.model,
    dimensions: providers.embeddings.dimensions,
    minSimilarity: providers.embeddings.minSimilarity,
    embed: async () => [vectors[replay % vectors.length] as number[]],
  },
};

function randomUnit(seed: number): number[] {
  // Cheap deterministic noise, so the table size is realistic without 10k API calls.
  let x = seed + 1;
  const v = Array.from({ length: EMBEDDING_DIM }, () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296 - 0.5;
  });
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}

for (const size of sizes) {
  const t = await createTestDb();
  try {
    const app = createApp(t.db, replayProviders);
    const token = await createToken(t.db, "eval");
    const [p] = await t.db
      .insert(projects)
      .values({ key: "eval/latency", name: "latency" })
      .returning();
    const real = (
      await providers.embeddings.embed(fixtureMemories.map((m) => m.content))
    ).map((v, i) => ({ v, content: fixtureMemories[i]?.content ?? "" }));
    for (let at = 0; at < size; at += 500) {
      const batch = Array.from({ length: Math.min(500, size - at) }, (_, i) => {
        const n = at + i;
        const r = real[n % real.length];
        return {
          scope: "project" as const,
          projectId: p?.id,
          owner: "eval",
          author: "eval",
          content: `${r?.content ?? ""} (${n})`,
          embedding: n < real.length ? (r?.v ?? null) : randomUnit(n),
          embeddingModel: providers.embeddings.model,
          embeddingDim: EMBEDDING_DIM,
        };
      });
      await t.db.insert(memories).values(batch);
    }
    await t.db.execute("ANALYZE memories" as never);
    const times: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < queries.length; i++) {
        replay = i;
        const t0 = performance.now();
        const res = await app.request("/api/search", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: queries[i],
            project: "eval/latency",
            limit: 5,
          }),
        });
        await res.arrayBuffer();
        if (round > 0) times.push(performance.now() - t0);
      }
    }
    const s = pct(times);
    console.log(
      `search @ ${String(size).padStart(6)} memories: p50 ${ms(s.p50)}  p95 ${ms(s.p95)}  max ${ms(s.max)}   (local database; add your network hop to Fly)`,
    );
  } finally {
    await t.drop();
  }
}
