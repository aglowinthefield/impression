import {
  type EmbeddingProvider,
  type Fetch,
  type LlmProvider,
  ProviderError,
  postJson,
  type UsageSink,
} from "./types.js";

export interface OllamaOptions {
  baseUrl?: string;
  fetch?: Fetch;
  onUsage?: UsageSink;
}

export function ollamaEmbeddings(
  opts: OllamaOptions & {
    model: string;
    dimensions: number;
    minSimilarity?: number;
  },
): EmbeddingProvider {
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";
  return {
    model: opts.model,
    dimensions: opts.dimensions,
    minSimilarity: opts.minSimilarity,
    async embed(texts) {
      if (texts.length === 0) return [];
      const json = (await postJson(
        "ollama",
        fetchFn,
        `${baseUrl}/api/embed`,
        {},
        {
          model: opts.model,
          input: texts,
        },
      )) as { embeddings?: number[][]; prompt_eval_count?: number };
      if (!json.embeddings || json.embeddings.length !== texts.length) {
        throw new ProviderError("ollama", "unexpected embed response");
      }
      opts.onUsage?.({
        kind: "embedding",
        provider: "ollama",
        model: opts.model,
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: 0,
      });
      return json.embeddings;
    },
  };
}

export function ollamaLlm(
  opts: OllamaOptions & { model: string },
): LlmProvider {
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";
  return {
    model: opts.model,
    async complete({ system, prompt, maxTokens }) {
      const json = (await postJson(
        "ollama",
        fetchFn,
        `${baseUrl}/api/chat`,
        {},
        {
          model: opts.model,
          stream: false,
          options: { num_predict: maxTokens ?? 1024 },
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: prompt },
          ],
        },
      )) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const text = json.message?.content;
      if (text === undefined)
        throw new ProviderError("ollama", "unexpected chat response");
      opts.onUsage?.({
        kind: "completion",
        provider: "ollama",
        model: opts.model,
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
      });
      return text;
    },
  };
}
