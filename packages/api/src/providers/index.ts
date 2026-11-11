import { EMBEDDING_DIM } from "../db/schema.js";
import { anthropicLlm } from "./anthropic.js";
import { ollamaEmbeddings, ollamaLlm } from "./ollama.js";
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
 *   EMBEDDING_MODEL, LLM_MODEL, OLLAMA_URL override model names and the Ollama host.
 *   EMBEDDING_MIN_SIMILARITY sets the search floor (Ollama default 0.45, tuned on nomic-embed-text).
 *
 * The embedding column is `EMBEDDING_DIM` wide, so a provider with another
 * dimension is rejected here rather than failing on the first insert.
 * `onUsage` receives the token usage of every successful call.
 */
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
  if (llmKind === "anthropic") {
    llm = anthropicLlm({
      apiKey: need(env, "ANTHROPIC_API_KEY", "when LLM_PROVIDER=anthropic"),
      model: env.LLM_MODEL,
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
  } else {
    throw new Error(`unknown LLM_PROVIDER "${llmKind}" (anthropic or ollama)`);
  }

  return { embeddings, llm };
}
