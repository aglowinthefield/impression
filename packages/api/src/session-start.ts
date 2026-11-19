import { and, eq, inArray, sql } from "drizzle-orm";
import { type CoreItem, estimateTokens } from "./core.js";
import type { Db } from "./db/client.js";
import { conceptMemories, concepts, memories } from "./db/schema.js";

export type StartItem = CoreItem;

export interface ConceptLine {
  id: string;
  name: string;
  summary: string;
  /** Subtopics are indented under their area. */
  sub: boolean;
}

export interface ConceptStart {
  /** Practices, as the top-N set has them. */
  base: StartItem[];
  /** The project's concepts, areas first with their subtopics under them. */
  map: ConceptLine[];
  /** One memory from each concept, biggest concepts first, as the budget allows. */
  top: StartItem[];
  tokens: number;
}

/** Words a map line keeps of a concept's summary. */
export const MAP_WORDS = 12;

/** The first sentence of a summary, cut to `MAP_WORDS` words. */
export function shortSummary(summary: string): string {
  const first = summary.split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]$/, "") ?? "";
  const words = first.split(/\s+/).filter(Boolean);
  return words.length > MAP_WORDS
    ? `${words.slice(0, MAP_WORDS).join(" ")}...`
    : words.join(" ");
}

/**
 * The concept version of the session-start set: the practices the top-N
 * set leads with, a map of the person's concepts in the
 * project with one-line summaries, then the best memory of each concept,
 * biggest first, until the budget runs out.
 */
export async function conceptStart(
  db: Db,
  projectId: string,
  owner: string,
  core: StartItem[],
  budget: number,
): Promise<ConceptStart> {
  const base = core.filter((i) => i.tags.includes("practice"));
  let used = base.reduce((n, i) => n + estimateTokens(i.content) + 2, 0);

  const cs = await db
    .select({
      id: concepts.id,
      parentId: concepts.parentId,
      name: concepts.name,
      summary: concepts.summary,
      count: sql<number>`count(${memories.id})::int`,
    })
    .from(concepts)
    .leftJoin(conceptMemories, eq(conceptMemories.conceptId, concepts.id))
    .leftJoin(
      memories,
      and(
        eq(memories.id, conceptMemories.memoryId),
        inArray(memories.status, ["active", "possibly_stale"]),
      ),
    )
    .where(and(eq(concepts.projectId, projectId), eq(concepts.owner, owner)))
    .groupBy(concepts.id);
  const byId = new Map(cs.map((c) => [c.id, c]));
  const kids = (id: string) =>
    cs.filter((c) => c.parentId === id).sort((a, b) => b.count - a.count);
  const total = (id: string) =>
    (byId.get(id)?.count ?? 0) + kids(id).reduce((n, k) => n + k.count, 0);
  const areas = cs
    .filter((c) => !c.parentId || !byId.has(c.parentId))
    .sort((a, b) => total(b.id) - total(a.id));

  const map: ConceptLine[] = [];
  for (const a of areas) {
    for (const [c, sub] of [
      [a, false] as const,
      ...kids(a.id).map((k) => [k, true] as const),
    ]) {
      const summary = shortSummary(c.summary);
      const line = `${c.name}: ${summary}`;
      const cost = estimateTokens(line) + 2;
      if (used + cost > budget) continue;
      used += cost;
      map.push({ id: c.id, name: c.name, summary, sub });
    }
  }

  // The best memory of each mapped concept: most confident, then newest.
  const ids = map.map((c) => c.id);
  const members = ids.length
    ? await db
        .select({
          conceptId: conceptMemories.conceptId,
          id: memories.id,
          content: memories.content,
          tags: memories.tags,
        })
        .from(conceptMemories)
        .innerJoin(memories, eq(memories.id, conceptMemories.memoryId))
        .where(
          and(
            inArray(conceptMemories.conceptId, ids),
            eq(memories.status, "active"),
          ),
        )
        .orderBy(
          sql`coalesce(${memories.confidence}, 0.5) desc`,
          sql`${memories.createdAt} desc`,
        )
    : [];
  const seen = new Set(base.map((i) => i.id));
  const top: StartItem[] = [];
  const bySize = [...map].sort(
    (a, b) => (byId.get(b.id)?.count ?? 0) - (byId.get(a.id)?.count ?? 0),
  );
  for (const c of bySize) {
    const m = members.find((x) => x.conceptId === c.id && !seen.has(x.id));
    if (!m) continue;
    const cost = estimateTokens(m.content) + 2;
    if (used + cost > budget) continue;
    used += cost;
    seen.add(m.id);
    top.push({ id: m.id, content: m.content, tags: m.tags });
  }
  return { base, map, top, tokens: used };
}
