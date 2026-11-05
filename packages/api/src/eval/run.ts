import { createApp } from "../app.js";
import { createToken } from "../auth.js";
import type { Providers } from "../providers/index.js";
import { createTestDb } from "../test-db.js";
import { memories, offTopic, pairs, queries } from "./fixture.js";

export interface SearchScores {
  /** Share of queries whose expected memory is in the top 3. */
  hitAt3: number;
  /** Mean reciprocal rank of the expected memory (0 when missing). */
  mrr: number;
  /** Share of off-topic queries that returned anything at all. */
  offTopicHits: number;
}

export async function evalSearch(
  providers: Providers,
  minSimilarities: number[],
): Promise<Map<number, SearchScores>> {
  const t = await createTestDb();
  try {
    const app = createApp(t.db, providers);
    const token = await createToken(t.db, "eval");
    const call = (path: string, body: unknown) =>
      app.request(`/api${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const ids = new Map<string, string>();
    for (const m of memories) {
      const res = (await (
        await call("/memories", {
          scope: "project",
          project: { key: "eval/fixture" },
          content: m.content,
          dedup: false,
        })
      ).json()) as { id: string };
      ids.set(res.id, m.id);
    }
    const search = async (q: string, minSimilarity: number) =>
      (
        (await (
          await call("/search", {
            query: q,
            project: "eval/fixture",
            limit: 10,
            minSimilarity,
          })
        ).json()) as { results: { id: string }[] }
      ).results.map((r) => ids.get(r.id));

    const out = new Map<number, SearchScores>();
    for (const min of minSimilarities) {
      let hits = 0;
      let rr = 0;
      for (const { q, expect } of queries) {
        const got = await search(q, min);
        const rank = got.indexOf(expect);
        if (rank >= 0 && rank < 3) hits++;
        if (rank >= 0) rr += 1 / (rank + 1);
      }
      let off = 0;
      for (const q of offTopic) if ((await search(q, min)).length > 0) off++;
      out.set(min, {
        hitAt3: hits / queries.length,
        mrr: rr / queries.length,
        offTopicHits: off / offTopic.length,
      });
    }
    return out;
  } finally {
    await t.drop();
  }
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / Math.sqrt(na * nb);
};

/** Cosine similarity of each pair group. The dedup candidate floor should sit below the paraphrase and conflict values and above the unrelated ones. */
export async function evalPairs(providers: Providers) {
  const result: Record<string, number[]> = {};
  for (const [group, list] of Object.entries(pairs)) {
    const vecs = await providers.embeddings.embed(list.flatMap((p) => [...p]));
    result[group] = list.map((_, i) =>
      cosine(vecs[2 * i] as number[], vecs[2 * i + 1] as number[]),
    );
  }
  return result;
}
