import {
  type Fetch,
  type LlmProvider,
  ProviderError,
  postJson,
  type UsageSink,
} from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  /** Defaults to a Haiku-class model: cheap and fast enough for extraction. */
  model?: string;
  baseUrl?: string;
  fetch?: Fetch;
  onUsage?: UsageSink;
}

export function anthropicLlm(opts: AnthropicOptions): LlmProvider {
  const model = opts.model ?? "claude-haiku-4-5";
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  return {
    model,
    async complete({ system, prompt, maxTokens }) {
      const json = (await postJson(
        "anthropic",
        fetchFn,
        `${baseUrl}/v1/messages`,
        { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: maxTokens ?? 1024,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        },
      )) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = json.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (text === undefined)
        throw new ProviderError("anthropic", "unexpected messages response");
      opts.onUsage?.({
        kind: "completion",
        provider: "anthropic",
        model,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      });
      return text;
    },
  };
}
