import { EMBEDDING_DIM } from "./db/schema.js";
import type { Providers } from "./providers/index.js";

/** Deterministic bag-of-words embeddings, so tests can check ranking without a network. */
export function fakeProviders(
  opts: { failEmbeddings?: boolean } = {},
): Providers & {
  embedCalls: string[][];
} {
  const embedCalls: string[][] = [];
  return {
    embedCalls,
    embeddings: {
      model: "fake-bow",
      dimensions: EMBEDDING_DIM,
      async embed(texts) {
        embedCalls.push(texts);
        if (opts.failEmbeddings) throw new Error("embedding service down");
        return texts.map((t) => {
          const v = new Array<number>(EMBEDDING_DIM).fill(0);
          for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
            let h = 0;
            for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % EMBEDDING_DIM;
            v[h] = (v[h] ?? 0) + 1;
          }
          return v;
        });
      },
    },
    llm: { model: "fake", complete: async () => "" },
  };
}
