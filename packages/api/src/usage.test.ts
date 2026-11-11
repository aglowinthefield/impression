import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { EMBEDDING_DIM, usageEvents } from "./db/schema.js";
import { openaiEmbeddings } from "./providers/index.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";
import { costMicros, UsageRecorder, withUsageContext } from "./usage.js";

let t: Awaited<ReturnType<typeof createTestDb>>;
let usage: UsageRecorder;
let app: ReturnType<typeof createApp>;
let alice: string;

beforeAll(async () => {
  t = await createTestDb();
  usage = new UsageRecorder(t.db);
  const embeddings = openaiEmbeddings({
    apiKey: "k",
    dimensions: EMBEDDING_DIM,
    onUsage: usage.record,
    fetch: async () =>
      Response.json({
        data: [{ index: 0, embedding: new Array(EMBEDDING_DIM).fill(0.1) }],
        usage: { prompt_tokens: 1_000_000 },
      }),
  });
  app = createApp(t.db, { ...fakeProviders(), embeddings });
  alice = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

describe("usage recording", () => {
  test("attributes a search's embedding call to the caller and API area", async () => {
    const res = await app.request("/api/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "how do we deploy" }),
    });
    expect(res.status).toBe(200);
    await usage.flush();
    const rows = await t.db.select().from(usageEvents);
    expect(rows).toMatchObject([
      {
        userId: null,
        principal: "alice",
        operation: "search",
        kind: "embedding",
        provider: "openai",
        model: "text-embedding-3-small",
        inputTokens: 1_000_000,
        outputTokens: 0,
        costMicros: 20_000,
      },
    ]);
    expect(usage.metrics.render()).toContain(
      'impression_model_tokens_total{direction="input",kind="embedding",model="text-embedding-3-small",operation="search",provider="openai"} 1000000',
    );
  });

  test("labels calls outside a request with the job context", async () => {
    const recorder = new UsageRecorder(null);
    await withUsageContext(
      { userId: null, principal: null, operation: "reembed" },
      () =>
        recorder.record({
          kind: "embedding",
          provider: "ollama",
          model: "nomic",
          inputTokens: 5,
          outputTokens: 0,
        }),
    );
    expect(recorder.metrics.render()).toContain('operation="reembed"');
  });
});

describe("costMicros", () => {
  test("prices known models, treats Ollama as free and leaves unknown models null", () => {
    const u = {
      kind: "completion",
      inputTokens: 1000,
      outputTokens: 200,
    } as const;
    expect(
      costMicros({ ...u, provider: "anthropic", model: "claude-haiku-4-5" }),
    ).toBe(2000);
    expect(costMicros({ ...u, provider: "ollama", model: "llama" })).toBe(0);
    expect(
      costMicros({ ...u, provider: "anthropic", model: "mystery" }),
    ).toBeNull();
  });
});
