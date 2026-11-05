import {
  type EmbeddingProvider,
  type Fetch,
  ProviderError,
  postJson,
} from "./types.js";

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  fetch?: Fetch;
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
      )) as { data?: { index: number; embedding: number[] }[] };
      const data = json.data;
      if (!data || data.length !== texts.length) {
        throw new ProviderError("openai", "unexpected embeddings response");
      }
      return [...data]
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}
