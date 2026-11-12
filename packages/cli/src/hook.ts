import { type ApiClient, resolveProject } from "@impression/shared";

interface Core {
  items: { content: string; pinned: boolean; tags?: string[] }[];
}

/**
 * Builds the text injected at session start, or null when there is nothing to
 * show or the API is unreachable. A hook must never break the session, so
 * every failure ends in null.
 */
export async function sessionStartContext(
  client: ApiClient,
  cwd: string,
  budget = 800,
): Promise<string | null> {
  try {
    const p = resolveProject(cwd);
    const qs = new URLSearchParams({ project: p.key, budget: String(budget) });
    if (p.pathPrefix) qs.set("path", p.pathPrefix);
    const core = (await client.get(`/core?${qs}`)) as Core;
    if (!core.items?.length) return null;
    const practices = core.items.filter((i) => i.tags?.includes("practice"));
    const facts = core.items.filter((i) => !i.tags?.includes("practice"));
    return [
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
    ].join("\n");
  } catch {
    return null;
  }
}

/**
 * Memories relevant to one prompt, or null when none match or the API is
 * unreachable. Run on every prompt, so it keeps the result short.
 */
export async function promptContext(
  client: ApiClient,
  cwd: string,
  prompt: string,
  limit = 5,
): Promise<string | null> {
  try {
    const query = prompt.trim().slice(0, 2000);
    if (!query) return null;
    const p = resolveProject(cwd);
    const r = (await client.post("/search", {
      query,
      project: p.key,
      limit,
      strict: true,
      ...(p.pathPrefix ? { path: p.pathPrefix } : {}),
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
