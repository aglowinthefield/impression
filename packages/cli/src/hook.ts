import { type ApiClient, resolveProject } from "@impression/shared";

/** Who is being served, so the server can log which memories reached which session. */
export interface ServeOptions {
  /** The agent's own session id. */
  session?: string;
  /** The agent name sessions are stored under, e.g. "claude-code" or "pi". */
  agent?: string;
}

interface Core {
  items: { content: string; tags?: string[] }[];
  /** False when this request can't store sessions for the project (a repo the GitHub app doesn't reach). */
  reachable?: boolean;
}

/** What session start found: the text to inject, and whether this repo's sessions can be saved. */
export interface SessionStart {
  context: string | null;
  /** False when the server can't store sessions for this repo. Undefined from older servers. */
  reachable?: boolean;
  /** The project key and name the session resolves to. */
  key: string;
  name: string;
}

/**
 * Fetches the core memories for session start. Null when the API is unreachable.
 * A hook must never break the session, so every failure ends in null.
 */
export async function sessionStart(
  client: ApiClient,
  cwd: string,
  opts: ServeOptions & { budget?: number } = {},
): Promise<SessionStart | null> {
  try {
    const p = resolveProject(cwd);
    const qs = new URLSearchParams({
      project: p.key,
      budget: String(opts.budget ?? 800),
    });
    if (p.pathPrefix) qs.set("path", p.pathPrefix);
    if (opts.session) qs.set("session", opts.session);
    if (opts.agent) qs.set("agent", opts.agent);
    const core = (await client.get(`/core?${qs}`)) as Core;
    const items = core.items ?? [];
    const practices = items.filter((i) => i.tags?.includes("practice"));
    const facts = items.filter((i) => !i.tags?.includes("practice"));
    const context = items.length
      ? [
          ...(practices.length > 0
            ? [
                "How this user likes to work (from Impression; follow these when they apply):",
                ...practices.map((i) => `- ${i.content}`),
              ]
            : []),
          ...(facts.length > 0
            ? [
                `Saved memories for ${p.name} (from Impression; use the impression search tool for more):`,
                ...facts.map((i) => `- ${i.content}`),
              ]
            : []),
        ].join("\n")
      : null;
    return { context, reachable: core.reachable, key: p.key, name: p.name };
  } catch {
    return null;
  }
}

/**
 * Builds the text injected at session start, or null when there is nothing to
 * show or the API is unreachable.
 */
export async function sessionStartContext(
  client: ApiClient,
  cwd: string,
  opts: ServeOptions & { budget?: number } = {},
): Promise<string | null> {
  return (await sessionStart(client, cwd, opts))?.context ?? null;
}

/** Session-start notice when the plugin is installed but nobody signed in. */
export const NOT_SIGNED_IN =
  "Impression isn't signed in, so it won't remember this session. Run: npx @aglowinthefield/impression setup";

/**
 * One line for the person (not the agent) at session start, or null when all is
 * well. Says when this repo's sessions can't be saved, or that the first ones are.
 */
export function sessionStartNotice(
  s: SessionStart | null,
  url: string,
): string | null {
  if (!s) return null;
  if (s.reachable === false)
    return `Impression can't reach ${s.key}, so this session won't be saved. Install the Impression GitHub app on that repo's account: ${url.replace(/\/+$/, "")}/start#repos`;
  if (!s.context)
    return `Impression is on. Memories from this session will show at ${url.replace(/\/+$/, "")}.`;
  return null;
}

/**
 * Memories relevant to one prompt, or null when none match or the API is
 * unreachable. Run on every prompt, so it keeps the result short.
 */
export async function promptContext(
  client: ApiClient,
  cwd: string,
  prompt: string,
  opts: ServeOptions & { limit?: number } = {},
): Promise<string | null> {
  try {
    const query = prompt.trim().slice(0, 2000);
    if (!query) return null;
    const p = resolveProject(cwd);
    const r = (await client.post("/search", {
      query,
      project: p.key,
      limit: opts.limit ?? 5,
      strict: true,
      source: "prompt",
      ...(p.pathPrefix ? { path: p.pathPrefix } : {}),
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
    })) as { results?: { content: string }[] };
    if (!r.results?.length) return null;
    return [
      "Memories from Impression that match this prompt:",
      ...r.results.map((m) => `- ${m.content}`),
    ].join("\n");
  } catch {
    return null;
  }
}
