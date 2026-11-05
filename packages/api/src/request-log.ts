import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "./auth.js";

export interface RequestLogEntry {
  at: string;
  method: string;
  path: string;
  /** Query parameters, e.g. `project` and `path` for /core. */
  query: Record<string, string>;
  /** Token name, or null when auth failed. */
  principal: string | null;
  /** "web" for the web UI, otherwise the user agent. */
  client: string;
  status: number;
  ms: number;
  /** The `error` field of a failed response. */
  error?: string;
  /** Length of `items` in the response, when it has one. */
  items?: number;
}

/**
 * Keeps the last `size` API requests in memory so the web UI can show what agents
 * are sending. Never records request bodies or tokens.
 */
export class RequestLog {
  private entries: RequestLogEntry[] = [];
  constructor(private size = 200) {}

  push(e: RequestLogEntry) {
    this.entries.push(e);
    if (this.entries.length > this.size) this.entries.shift();
  }

  /** Newest first. Shows `principal`'s own requests and failed-auth ones. */
  list(principal: string) {
    return this.entries
      .filter((e) => e.principal === principal || e.principal === null)
      .reverse();
  }

  middleware() {
    return createMiddleware<AuthEnv>(async (c, next) => {
      const start = performance.now();
      await next();
      const path = new URL(c.req.url).pathname;
      if (path.startsWith("/api/debug/")) return;
      const entry: RequestLogEntry = {
        at: new Date().toISOString(),
        method: c.req.method,
        path,
        query: c.req.query(),
        principal: c.get("principal") ?? null,
        client:
          c.req.header("x-impression-client") ??
          c.req.header("user-agent") ??
          "unknown",
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      };
      if (c.res.headers.get("content-type")?.includes("application/json")) {
        const json = await c.res
          .clone()
          .json()
          .catch(() => null);
        if (typeof json?.error === "string") entry.error = json.error;
        if (Array.isArray(json?.items)) entry.items = json.items.length;
      }
      this.push(entry);
    });
  }

  routes() {
    const app = new Hono<AuthEnv>();
    app.get("/requests", (c) =>
      c.json({ items: this.list(c.get("principal")) }),
    );
    return app;
  }
}
