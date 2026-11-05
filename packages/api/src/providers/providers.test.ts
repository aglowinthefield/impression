import { describe, expect, test } from "vitest";
import { EMBEDDING_DIM } from "../db/schema.js";
import { anthropicLlm } from "./anthropic.js";
import { createProviders, type Fetch, ProviderError } from "./index.js";
import { ollamaEmbeddings, ollamaLlm } from "./ollama.js";
import { openaiEmbeddings } from "./openai.js";

function fakeFetch(reply: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: Fetch = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(
      typeof reply === "string" ? reply : JSON.stringify(reply),
      { status },
    );
  };
  return { fn, calls, body: () => JSON.parse(String(calls[0]?.init.body)) };
}

describe("openaiEmbeddings", () => {
  test("sends the model, dimensions and key, and returns vectors in input order", async () => {
    const f = fakeFetch({
      data: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] },
      ],
    });
    const p = openaiEmbeddings({ apiKey: "k", fetch: f.fn });
    expect(await p.embed(["a", "b"])).toEqual([[1], [2]]);
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(new Headers(f.calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer k",
    );
    expect(f.body()).toMatchObject({
      model: "text-embedding-3-small",
      dimensions: 768,
      input: ["a", "b"],
    });
    expect([p.model, p.dimensions]).toEqual(["text-embedding-3-small", 768]);
  });

  test("makes no request for empty input", async () => {
    const f = fakeFetch({});
    expect(
      await openaiEmbeddings({ apiKey: "k", fetch: f.fn }).embed([]),
    ).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test("turns an HTTP error into a ProviderError with the status", async () => {
    const f = fakeFetch("bad key", 401);
    await expect(
      openaiEmbeddings({ apiKey: "k", fetch: f.fn }).embed(["a"]),
    ).rejects.toThrow(/openai: HTTP 401 bad key/);
  });

  test("rejects a response with the wrong number of vectors", async () => {
    const f = fakeFetch({ data: [] });
    await expect(
      openaiEmbeddings({ apiKey: "k", fetch: f.fn }).embed(["a"]),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("anthropicLlm", () => {
  test("posts a message and joins text blocks", async () => {
    const f = fakeFetch({
      content: [
        { type: "text", text: "hel" },
        { type: "text", text: "lo" },
      ],
    });
    const llm = anthropicLlm({ apiKey: "k", fetch: f.fn });
    expect(
      await llm.complete({ system: "s", prompt: "p", maxTokens: 50 }),
    ).toBe("hello");
    const h = new Headers(f.calls[0]?.init.headers);
    expect(h.get("x-api-key")).toBe("k");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    expect(f.body()).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 50,
      system: "s",
      messages: [{ role: "user", content: "p" }],
    });
  });
});

describe("ollama", () => {
  test("embeds through /api/embed", async () => {
    const f = fakeFetch({ embeddings: [[1, 2]] });
    const p = ollamaEmbeddings({ model: "m", dimensions: 2, fetch: f.fn });
    expect(await p.embed(["a"])).toEqual([[1, 2]]);
    expect(f.calls[0]?.url).toBe("http://localhost:11434/api/embed");
  });

  test("completes through /api/chat without streaming", async () => {
    const f = fakeFetch({ message: { content: "hi" } });
    const llm = ollamaLlm({ model: "m", fetch: f.fn });
    expect(await llm.complete({ prompt: "p" })).toBe("hi");
    expect(f.body()).toMatchObject({
      stream: false,
      messages: [{ role: "user", content: "p" }],
    });
  });
});

describe("createProviders", () => {
  const keys = { OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" };

  test("defaults to OpenAI embeddings and an Anthropic Haiku model", () => {
    const p = createProviders(keys);
    expect(p.embeddings).toMatchObject({
      model: "text-embedding-3-small",
      dimensions: EMBEDDING_DIM,
    });
    expect(p.llm.model).toBe("claude-haiku-4-5");
  });

  test("names the missing key", () => {
    expect(() => createProviders({ ANTHROPIC_API_KEY: "a" })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  test("rejects an unknown provider", () => {
    expect(() => createProviders({ ...keys, LLM_PROVIDER: "nope" })).toThrow(
      /unknown LLM_PROVIDER/,
    );
  });

  test("selects Ollama for both", () => {
    const p = createProviders({
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_MODEL: "big-embed",
      EMBEDDING_DIMENSIONS: String(EMBEDDING_DIM),
      LLM_PROVIDER: "ollama",
      LLM_MODEL: "qwen",
    });
    expect([p.embeddings.model, p.llm.model]).toEqual(["big-embed", "qwen"]);
  });

  test("rejects an embedding model whose size doesn't match the column", () => {
    expect(() =>
      createProviders({
        ...keys,
        EMBEDDING_PROVIDER: "ollama",
        EMBEDDING_MODEL: "mxbai-embed-large",
        EMBEDDING_DIMENSIONS: "1024",
      }),
    ).toThrow(/1024 dimensions but the database column is 768/);
  });
});
