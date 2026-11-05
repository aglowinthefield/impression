import { eq, isNull } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { memories, proposals } from "./db/schema.js";
import type { Providers } from "./providers/index.js";

const BATCH = 32;

/**
 * Embeds every memory and proposal that has no vector, e.g. after a change of
 * embedding model or dimension. Safe to re-run: it only touches rows without one.
 */
export async function reembed(
  db: Db,
  providers: Providers,
): Promise<{ memories: number; proposals: number }> {
  const { model, dimensions } = providers.embeddings;
  const done = { memories: 0, proposals: 0 };

  const mems = await db
    .select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(isNull(memories.embedding));
  for (let i = 0; i < mems.length; i += BATCH) {
    const batch = mems.slice(i, i + BATCH);
    const vecs = await providers.embeddings.embed(batch.map((m) => m.content));
    for (const [j, m] of batch.entries()) {
      await db
        .update(memories)
        .set({
          embedding: vecs[j],
          embeddingModel: model,
          embeddingDim: dimensions,
        })
        .where(eq(memories.id, m.id));
      done.memories++;
    }
  }

  const props = await db
    .select({ id: proposals.id, content: proposals.content })
    .from(proposals)
    .where(isNull(proposals.embedding));
  for (let i = 0; i < props.length; i += BATCH) {
    const batch = props.slice(i, i + BATCH);
    const vecs = await providers.embeddings.embed(batch.map((p) => p.content));
    for (const [j, p] of batch.entries()) {
      await db
        .update(proposals)
        .set({ embedding: vecs[j] })
        .where(eq(proposals.id, p.id));
      done.proposals++;
    }
  }
  return done;
}
