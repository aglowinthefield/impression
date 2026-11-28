import { EMBEDDING_DIM } from "../db/schema.js";
import { anthropicLlm } from "./anthropic.js";
import { ollamaEmbeddings, ollamaLlm } from "./ollama.js";
import { hasPrice } from "../usage.js";
import { openaiEmbeddings } from "./openai.js";
import type {
  EmbeddingProvider,
  Fetch,
  LlmProvider,
  UsageSink,
} from "./types.js";

export * from "./types.js";
export { anthropicLlm, ollamaEmbeddings, ollamaLlm, openaiEmbeddings };

export interface Providers {
  embeddings: EmbeddingProvider;
  llm: LlmProvider;
  /** A stronger model for dreaming, which groups a whole project in one call. */
  dreamLlm: LlmProvider;
  /** Extracts backfilled past sessions. Stronger than `llm`, and budgeted per person. */
  backfillLlm: LlmProvider;
}

type Env = Record<string, string | undefined>;

function need(env: Env, key: string, why: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required ${why}`);
  return v;
}

/**
 * Builds providers from env.
 *
 *   EMBEDDING_PROVIDER = openai (default) | ollama
 *   LLM_PROVIDER       = anthropic (default) | ollama
 *   EMBEDDING_MODEL, LLM_MODEL, DREAM_MODEL, BACKFILL_MODEL, OLLAMA_URL override model names and the Ollama host.
 *   EMBEDDING_MIN_SIMILARITY sets the search floor (Ollama default 0.45, tuned on nomic-embed-text).
 *
 * The embedding column is `EMBEDDING_DIM` wide, so a provider with another
 * dimension is rejected here rather than failing on the first insert.
 * `onUsage` receives the token usage of every successful call.
 */
/** Anthropic model for dreaming. In testing it left 1 of 100 memories ungrouped, where Haiku left 5 to 18. */
export const DREAM_MODEL = "claude-sonnet-5-5";

/** Anthropic model for backfill extraction. Old sessions are read once, so a stronger model is worth it. */
export const BACKFILL_MODEL = "claude-sonnet-5-5";

export function createProviders(
  env: Env = process.env,
  fetchFn?: Fetch,
  onUsage?: UsageSink,
): Providers {
  const embeddingKind = env.EMBEDDING_PROVIDER ?? "openai";
  const llmKind = env.LLM_PROVIDER ?? "anthropic";
  const ollamaUrl = env.OLLAMA_URL;

  let embeddings: EmbeddingProvider;
  if (embeddingKind === "openai") {
    embeddings = openaiEmbeddings({
      apiKey: need(env, "OPENAI_API_KEY", "when EMBEDDING_PROVIDER=openai"),
      model: env.EMBEDDING_MODEL || undefined,
      dimensions: EMBEDDING_DIM,
      fetch: fetchFn,
      onUsage,
    });
  } else if (embeddingKind === "ollama") {
    embeddings = ollamaEmbeddings({
      model: need(env, "EMBEDDING_MODEL", "when EMBEDDING_PROVIDER=ollama"),
      dimensions: Number(
        need(env, "EMBEDDING_DIMENSIONS", "when EMBEDDING_PROVIDER=ollama"),
      ),
      // nomic-embed-text scores unrelated text near 0.45, so 0.25 would let everything through.
      minSimilarity: Number(env.EMBEDDING_MIN_SIMILARITY ?? 0.45),
      baseUrl: ollamaUrl,
      fetch: fetchFn,
      onUsage,
    });
  } else {
    throw new Error(
      `unknown EMBEDDING_PROVIDER "${embeddingKind}" (openai or ollama)`,
    );
  }
  if (embeddings.dimensions !== EMBEDDING_DIM) {
    throw new Error(
      `embedding model ${embeddings.model} has ${embeddings.dimensions} dimensions but the database column is ${EMBEDDING_DIM}. Pick a ${EMBEDDING_DIM}-dimension model, or change EMBEDDING_DIM, migrate and re-embed.`,
    );
  }

  let llm: LlmProvider;
  let dreamLlm: LlmProvider;
  let backfillLlm: LlmProvider;
  if (llmKind === "anthropic") {
    const apiKey = need(
      env,
      "ANTHROPIC_API_KEY",
      "when LLM_PROVIDER=anthropic",
    );
    llm = anthropicLlm({
      apiKey,
      model: env.LLM_MODEL || undefined,
      fetch: fetchFn,
      onUsage,
    });
    dreamLlm = anthropicLlm({
      apiKey,
      model: env.DREAM_MODEL || DREAM_MODEL,
      fetch: fetchFn,
      onUsage,
    });
    backfillLlm = anthropicLlm({
      apiKey,
      model: env.BACKFILL_MODEL || BACKFILL_MODEL,
      fetch: fetchFn,
      onUsage,
    });
  } else if (llmKind === "ollama") {
    llm = ollamaLlm({
      model: need(env, "LLM_MODEL", "when LLM_PROVIDER=ollama"),
      baseUrl: ollamaUrl,
      fetch: fetchFn,
      onUsage,
    });
    dreamLlm = env.DREAM_MODEL
      ? ollamaLlm({
          model: env.DREAM_MODEL,
          baseUrl: ollamaUrl,
          fetch: fetchFn,
          onUsage,
        })
      : llm;
    backfillLlm = env.BACKFILL_MODEL
      ? ollamaLlm({
          model: env.BACKFILL_MODEL,
          baseUrl: ollamaUrl,
          fetch: fetchFn,
          onUsage,
        })
      : llm;
  } else {
    throw new Error(`unknown LLM_PROVIDER "${llmKind}" (anthropic or ollama)`);
  }
  // Without a price, backfill spend reads as $0: the budget never runs out and plans estimate nothing.
  if (!hasPrice(backfillLlm.provider ?? "anthropic", backfillLlm.model)) {
    throw new Error(
      `BACKFILL_MODEL "${backfillLlm.model}" has no price, so backfill spend couldn't be counted against BACKFILL_BUDGET_USD. Pick a priced model or add its price in packages/api/src/usage.ts.`,
    );
  }

  return { embeddings, llm, dreamLlm, backfillLlm };
}
