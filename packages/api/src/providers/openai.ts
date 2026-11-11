import {
  type EmbeddingProvider,
  type Fetch,
  ProviderError,
  postJson,
  type UsageSink,
} from "./types.js";

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetch?: Fetch;
  onUsage?: UsageSink;
}

export function openaiEmbeddings(
  opts: OpenAIEmbeddingOptions,
): EmbeddingProvider {
  const model = opts.model ?? "text-embedding-3-small";
  const dimensions = opts.dimensions ?? 768;
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  return {
    model,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      const json = (await postJson(
        "openai",
        fetchFn,
        `${baseUrl}/embeddings`,
        { authorization: `Bearer ${opts.apiKey}` },
        { model, input: texts, dimensions, encoding_format: "float" },
      )) as {
        data?: { index: number; embedding: number[] }[];
        usage?: { prompt_tokens?: number };
      };
      const data = json.data;
      if (!data || data.length !== texts.length) {
        throw new ProviderError("openai", "unexpected embeddings response");
      }
      opts.onUsage?.({
        kind: "embedding",
        provider: "openai",
        model,
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: 0,
      });
      return [...data]
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}
