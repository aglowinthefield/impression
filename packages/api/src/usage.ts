import { AsyncLocalStorage } from "node:async_hooks";
import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { usageEvents } from "./db/schema.js";
import type { ModelUsage } from "./providers/index.js";

/** Who a model call is billed to. Set per request by `usageContext()`. */
export interface UsageContext {
  userId: string | null;
  principal: string | null;
  operation: string;
}

const storage = new AsyncLocalStorage<UsageContext>();

/** Runs `fn` with model calls attributed to `ctx`, for jobs outside a request. */
export function withUsageContext<T>(ctx: UsageContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** After auth: attributes model calls in this request to its user and API area. */
export function usageContext() {
  return createMiddleware<AuthEnv>((c, next) => {
    const area = new URL(c.req.url).pathname.split("/")[2] || "api";
    return storage.run(
      {
        userId: c.get("access")?.userId ?? null,
        principal: c.get("principal") ?? null,
        operation: area,
      },
      next,
    );
  });
}

/** US dollars per million tokens: [input, output]. */
const PRICES: Record<string, [number, number]> = {
  "openai/text-embedding-3-small": [0.02, 0],
  "openai/text-embedding-3-large": [0.13, 0],
  "anthropic/claude-haiku-4-5": [1, 5],
  "anthropic/claude-sonnet-4-5": [3, 15],
};

/** Estimated cost in millionths of a dollar. 0 for local Ollama models, null for unknown ones. */
export function costMicros(u: ModelUsage): number | null {
  if (u.provider === "ollama") return 0;
  const price = PRICES[`${u.provider}/${u.model}`];
  if (!price) return null;
  return Math.round(u.inputTokens * price[0] + u.outputTokens * price[1]);
}

type Labels = Record<string, string>;

/** Counters in the Prometheus text format, so Fly can scrape them into Grafana. */
export class Metrics {
  private counters = new Map<
    string,
    { help: string; values: Map<string, number> }
  >();

  inc(name: string, help: string, labels: Labels, by = 1) {
    let c = this.counters.get(name);
    if (!c) {
      c = { help, values: new Map() };
      this.counters.set(name, c);
    }
    const key = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
      .join(",");
    c.values.set(key, (c.values.get(key) ?? 0) + by);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, c] of this.counters) {
      lines.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [key, v] of c.values) lines.push(`${name}{${key}} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/**
 * Records every model call as a `usage_events` row and as Prometheus counters.
 * Metrics carry no user labels, so per-user numbers come from the table.
 */
export class UsageRecorder {
  constructor(
    private db: Db | null,
    readonly metrics = new Metrics(),
  ) {}

  private pending = new Set<Promise<void>>();

  /** Waits for queued inserts, so a CLI can close the database afterwards. */
  async flush() {
    await Promise.all(this.pending);
  }

  readonly record = (u: ModelUsage): Promise<void> => {
    const ctx = storage.getStore() ?? {
      userId: null,
      principal: null,
      operation: "job",
    };
    const cost = costMicros(u);
    const labels = {
      kind: u.kind,
      provider: u.provider,
      model: u.model,
      operation: ctx.operation,
    };
    this.metrics.inc("impression_model_calls_total", "Model calls.", labels);
    this.metrics.inc(
      "impression_model_tokens_total",
      "Model tokens used.",
      { ...labels, direction: "input" },
      u.inputTokens,
    );
    this.metrics.inc(
      "impression_model_tokens_total",
      "Model tokens used.",
      { ...labels, direction: "output" },
      u.outputTokens,
    );
    if (cost !== null) {
      this.metrics.inc(
        "impression_model_cost_micro_usd_total",
        "Estimated model cost in millionths of a US dollar.",
        labels,
        cost,
      );
    }
    if (!this.db) return Promise.resolve();
    // Never fail or slow the model call over bookkeeping.
    const p = this.db
      .insert(usageEvents)
      .values({ ...ctx, ...u, costMicros: cost })
      .then(
        () => undefined,
        (err) => console.error("recording usage failed:", err),
      )
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  };
}
