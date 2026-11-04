import { type ApiClient, resolveProject } from "@impression/shared";

interface Core {
  items: { content: string; pinned: boolean }[];
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
    return [
      `Saved memories for ${p.name} (from Impression; use the impression search tool for more):`,
      ...core.items.map((i) => `- ${i.content}`),
    ].join("\n");
  } catch {
    return null;
  }
}

/** Claude Code SessionStart hook output. */
export function claudeCodeOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}
