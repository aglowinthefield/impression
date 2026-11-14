import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { findProject, memoryVisible } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { memories, projects } from "./db/schema.js";
import { toDto, withAnchors } from "./memories.js";
import type { Providers } from "./providers/index.js";
import { logServes } from "./serves.js";

/**
 * Without a floor the vector leg returns its nearest neighbours even when none
 * is related. This default is a first guess for text-embedding-3-small; the
 * retrieval eval (#26) is where to tune it.
 */
export const DEFAULT_MIN_SIMILARITY = 0.3;
/** Added to the floor for strict searches. On the realistic-prompt eval, 0.3 to 0.4 cut injected memories from 2.2 to 1.8 per prompt for the same recall; with the text floor, precision rose to 0.6. */
export const STRICT_EXTRA = 0.1;

const body = z.object({
  query: z.string().trim().min(1).max(2000),
  scope: z.enum(["user", "project"]).optional(),
  project: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  /** Working path relative to the repo root. Memories narrowed to other paths are left out. */
  path: z.string().min(1).optional(),
  status: z
    .enum(["active", "possibly_stale", "superseded", "retired"])
    .optional(),
  limit: z.number().int().min(1).max(50).default(10),
  /** Cosine similarity floor for the vector leg, 0 to 1. Weaker matches are dropped. */
  minSimilarity: z.number().min(0).max(1).optional(),
  /** Raises the model's floor by STRICT_EXTRA. For injection into a prompt, where a wrong memory costs more than a missed one. */
  strict: z.boolean().optional(),
  /** The agent's own session id, recorded with what is served. Ignored when malformed. */
  session: z.string().min(1).max(200).optional().catch(undefined),
  agent: z.string().min(1).max(100).optional().catch(undefined),
  /** "prompt" when a hook injects the results into a prompt, "web" for a person in the dashboard (not logged), otherwise an agent's search. */
  source: z.enum(["prompt", "search", "web"]).default("search"),
});

/** How many candidates each ranking contributes before fusion. */
const CANDIDATES = 50;
/** Reciprocal rank fusion constant. Larger values flatten the gap between ranks. */
const RRF_K = 60;
/** Share of the vector floor a full-text hit must still reach. */
const TEXT_FLOOR_SHARE = 0.8;

/** Turns free text into an OR query, so a long question still matches on any of its words. */
export function toTsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  return words && words.length > 0 ? words.join(" or ") : null;
}

export function searchRoutes(db: Db, providers: Providers) {
  const app = new Hono<AuthEnv>();

  app.post("/", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const q = parsed.data;
    const principal = c.get("principal");

    const conds = [
      await memoryVisible(db, c.get("access"), principal, "m"),
      q.status
        ? sql`m.status = ${q.status}`
        : sql`m.status IN ('active', 'possibly_stale')`,
    ];
    if (q.scope) conds.push(sql`m.scope = ${q.scope}`);
    if (q.tag) conds.push(sql`${q.tag} = ANY(m.tags)`);
    let projectId: string | null = null;
    if (q.project) {
      const p = await findProject(db, c.get("access"), q.project);
      projectId = p?.id ?? null;
      conds.push(p ? sql`m.project_id = ${p.id}` : sql`false`);
    }
    if (q.path) {
      const path = q.path.replace(/^\/+|\/+$/g, "");
      conds.push(
        sql`(m.path_prefix IS NULL OR ${path} = m.path_prefix OR starts_with(${path}, m.path_prefix || '/'))`,
      );
    }
    const minSimilarity =
      q.minSimilarity ??
      (providers.embeddings.minSimilarity ?? DEFAULT_MIN_SIMILARITY) +
        (q.strict ? STRICT_EXTRA : 0);
    const where = sql.join(conds, sql` AND `);

    // Vector ranking. If the embedding call fails, search degrades to full text only.
    let vectorRanks: { id: string; rank: number }[] = [];
    let queryVector: string | null = null;
    let degraded = false;
    try {
      const [vec] = await providers.embeddings.embed([q.query]);
      if (vec) {
        const literal = JSON.stringify(vec);
        queryVector = literal;
        const rows = await db.execute<{ id: string }>(sql`
          SELECT m.id FROM memories m
          WHERE ${where} AND m.embedding IS NOT NULL
            AND 1 - (m.embedding <=> ${literal}::vector) >= ${minSimilarity}
          ORDER BY m.embedding <=> ${literal}::vector
          LIMIT ${CANDIDATES}`);
        vectorRanks = rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
      }
    } catch (err) {
      degraded = true;
      console.error(
        "search embedding failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // A word match alone is weak evidence ("save" matches a memory about saving passwords).
    // When the query has an embedding, a text hit must also be at least loosely similar in meaning.
    const textFloor = queryVector
      ? sql`(m.embedding IS NULL OR 1 - (m.embedding <=> ${queryVector}::vector) >= ${minSimilarity * TEXT_FLOOR_SHARE})`
      : sql`true`;
    let textRanks: { id: string; rank: number }[] = [];
    const tsq = toTsQuery(q.query);
    if (tsq) {
      const rows = await db.execute<{ id: string }>(sql`
        SELECT m.id FROM memories m
        WHERE ${where} AND ${textFloor} AND m.search @@ websearch_to_tsquery('english', ${tsq})
        ORDER BY ts_rank_cd(m.search, websearch_to_tsquery('english', ${tsq})) DESC, m.id
        LIMIT ${CANDIDATES}`);
      textRanks = rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
    }

    const scores = new Map<string, number>();
    for (const { id, rank } of [...vectorRanks, ...textRanks]) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
    const top = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, q.limit);
    if (top.length === 0) return c.json({ results: [], degraded });

    const rows = await db
      .select({ m: memories, projectKey: projects.key })
      .from(memories)
      .leftJoin(projects, eq(memories.projectId, projects.id))
      .where(
        inArray(
          memories.id,
          top.map(([id]) => id),
        ),
      );
    const byId = new Map(rows.map((r) => [r.m.id, r]));

    const ranked = top.flatMap(([id, score]) => {
      const r = byId.get(id);
      if (!r) return [];
      return [
        {
          ...toDto(r.m, r.projectKey),
          score,
          stale: r.m.status === "possibly_stale",
          warning:
            r.m.status === "possibly_stale"
              ? `May be out of date: ${r.m.staleReason ?? "flagged stale"}`
              : null,
        },
      ];
    });
    const results = await withAnchors(db, ranked);
    // The log is what agents were handed; a person searching the dashboard isn't one.
    if (q.source !== "web")
      await logServes(
        db,
        results.map((r) => r.id),
        {
          source: q.source,
          principal,
          access: c.get("access"),
          projectId,
          sessionKey: q.session,
          agent: q.agent,
        },
      );
    return c.json({ degraded, results });
  });

  return app;
}
