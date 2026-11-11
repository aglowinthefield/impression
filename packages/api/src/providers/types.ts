export interface EmbeddingProvider {
  /** Recorded on each memory, so a model change means a re-embed. */
  readonly model: string;
  readonly dimensions: number;
  /** Search similarity floor tuned for this model. Cosine scores differ a lot between models. */
  readonly minSimilarity?: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface CompleteRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmProvider {
  readonly model: string;
  complete(req: CompleteRequest): Promise<string>;
}

export type Fetch = typeof fetch;

/** Tokens one model call used, as the provider reported them. */
export interface ModelUsage {
  kind: "embedding" | "completion";
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Receives the usage of every successful model call. */
export type UsageSink = (usage: ModelUsage) => void;

export class ProviderError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

export async function postJson(
  provider: string,
  fetchFn: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(provider, `HTTP ${res.status} ${text}`);
  }
  return res.json();
}
