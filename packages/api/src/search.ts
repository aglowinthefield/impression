import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { memories, projects } from "./db/schema.js";
import { toDto, withAnchors } from "./memories.js";
import type { Providers } from "./providers/index.js";

/**
 * Without a floor the vector leg returns its nearest neighbours even when none
 * is related. This default is a first guess for text-embedding-3-small; the
 * retrieval eval (#26) is where to tune it.
 */
export const DEFAULT_MIN_SIMILARITY = 0.25;

const body = z.object({
  query: z.string().trim().min(1).max(2000),
  scope: z.enum(["user", "project"]).optional(),
  project: z.string().min(1).optional(),
  /** Working path relative to the repo root. Memories narrowed to other paths are left out. */
  path: z.string().min(1).optional(),
  status: z
    .enum(["active", "possibly_stale", "superseded", "retired"])
    .optional(),
  limit: z.number().int().min(1).max(50).default(10),
  /** Cosine similarity floor for the vector leg, 0 to 1. Weaker matches are dropped. */
  minSimilarity: z.number().min(0).max(1).default(DEFAULT_MIN_SIMILARITY),
});

/** How many candidates each ranking contributes before fusion. */
const CANDIDATES = 50;
/** Reciprocal rank fusion constant. Larger values flatten the gap between ranks. */
const RRF_K = 60;

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
      sql`(m.scope = 'project' OR (m.scope = 'user' AND m.owner = ${principal}))`,
      q.status
        ? sql`m.status = ${q.status}`
        : sql`m.status IN ('active', 'possibly_stale')`,
    ];
    if (q.scope) conds.push(sql`m.scope = ${q.scope}`);
    if (q.project) {
      conds.push(
        sql`m.project_id = (SELECT id FROM projects WHERE key = ${q.project})`,
      );
    }
    if (q.path) {
      const path = q.path.replace(/^\/+|\/+$/g, "");
      conds.push(
        sql`(m.path_prefix IS NULL OR ${path} = m.path_prefix OR starts_with(${path}, m.path_prefix || '/'))`,
      );
    }
    const where = sql.join(conds, sql` AND `);

    // Vector ranking. If the embedding call fails, search degrades to full text only.
    let vectorRanks: { id: string; rank: number }[] = [];
    let degraded = false;
    try {
      const [vec] = await providers.embeddings.embed([q.query]);
      if (vec) {
        const literal = JSON.stringify(vec);
        const rows = await db.execute<{ id: string }>(sql`
          SELECT m.id FROM memories m
          WHERE ${where} AND m.embedding IS NOT NULL
            AND 1 - (m.embedding <=> ${literal}::vector) >= ${q.minSimilarity}
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

    let textRanks: { id: string; rank: number }[] = [];
    const tsq = toTsQuery(q.query);
    if (tsq) {
      const rows = await db.execute<{ id: string }>(sql`
        SELECT m.id FROM memories m
        WHERE ${where} AND m.search @@ websearch_to_tsquery('english', ${tsq})
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
        },
      ];
    });
    return c.json({ degraded, results: await withAnchors(db, ranked) });
  });

  return app;
}
