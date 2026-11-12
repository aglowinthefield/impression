import { type ApiClient, resolveProject } from "@impression/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface SearchResult {
  id: string;
  content: string;
  scope: string;
  pathPrefix: string | null;
  stale: boolean;
  warning: string | null;
}

interface Options {
  client: ApiClient;
  /** Directory the project key is resolved from. */
  cwd: string;
}

declare const __IMPRESSION_VERSION__: string | undefined;
/** Set by the bundler; "dev" when run from a plain tsc build. */
const VERSION =
  typeof __IMPRESSION_VERSION__ === "string" ? __IMPRESSION_VERSION__ : "dev";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

export function createServer({ client, cwd }: Options): McpServer {
  const server = new McpServer({ name: "impression", version: VERSION });
  const project = () => resolveProject(cwd);

  server.registerTool(
    "search",
    {
      description:
        "Search saved memories about this project (decisions, conventions, gotchas) and the user's own notes. Call before starting work that may depend on earlier decisions.",
      inputSchema: {
        query: z.string().min(1).describe("What you want to know"),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ query, limit }) => {
      try {
        const p = project();
        const body = (await client.post("/search", {
          query,
          project: p.key,
          limit: limit ?? 5,
          ...(p.pathPrefix ? { path: p.pathPrefix } : {}),
        })) as { results: SearchResult[] };
        if (body.results.length === 0) return text("No matching memories.");
        return text(
          body.results
            .map(
              (r) =>
                `- ${r.content}${r.warning ? ` (${r.warning})` : ""} [${r.id}]`,
            )
            .join("\n"),
        );
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  server.registerTool(
    "add",
    {
      description:
        "Save a durable fact worth remembering: a decision and its reason, a convention, a gotcha. Not for task progress or things obvious from the code.",
      inputSchema: {
        content: z.string().min(1).max(10_000),
        scope: z
          .enum(["project", "user"])
          .optional()
          .describe(
            "project (default) is shared with the team; user is private to you",
          ),
      },
    },
    async ({ content, scope }) => {
      try {
        const p = project();
        const r = (await client.post("/memories", {
          scope: scope ?? "project",
          content,
          project: { key: p.key, name: p.name },
          ...(p.pathPrefix ? { pathPrefix: p.pathPrefix } : {}),
          agent: "mcp",
        })) as { outcome?: string; id: string; redactions?: unknown[] };
        const note =
          r.outcome === "duplicate"
            ? "Already known, nothing added."
            : r.outcome === "superseded"
              ? "Saved. It replaces an older memory."
              : "Saved.";
        return text(`${note} [${r.id}]`);
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  return server;
}
