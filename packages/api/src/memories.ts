import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { anchors, memories, projects } from "./db/schema.js";
import type { Providers } from "./providers/index.js";
import { decide, findCandidates, markSuperseded } from "./reconcile.js";
import { isEmptyAfterScrub, scrub } from "./scrub.js";

// Same value as PRACTICE_TAG in extract.ts, which imports this file.
const PRACTICE_TAG = "practice";

type MemoryRow = typeof memories.$inferSelect;

const projectRef = z.object({
  key: z.string().min(1),
  name: z.string().min(1).optional(),
});

/** A repo-relative path. Absolute paths and `..` would point outside the checkout. */
const anchorPath = z
  .string()
  .trim()
  .transform((p) => p.replace(/^(\.\/)+/, ""))
  .refine(
    (p) => p.length > 0 && !p.startsWith("/") && !p.split("/").includes(".."),
    {
      message: "anchor path must be relative to the repo root",
    },
  );

export const anchorInput = z.object({
  path: anchorPath,
  symbol: z.string().trim().min(1).optional(),
  /** Commit the memory was recorded at. */
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, "commitSha must be a hex git SHA"),
});

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,29}$/, "tags are lowercase words and dashes");

const createBody = z.object({
  // Team scope arrives with roles and approval after v1.
  scope: z.enum(["user", "project"]),
  content: z.string().trim().min(1).max(10_000),
  project: projectRef.optional(),
  pathPrefix: z.string().min(1).nullable().optional(),
  pinned: z.boolean().optional(),
  tags: z.array(tagSchema).max(10).default([]),
  confidence: z.number().min(0).max(1).optional(),
  agent: z.string().min(1).optional(),
  sessionId: z.uuid().optional(),
  /** Set false to skip the duplicate and contradiction check. */
  dedup: z.boolean().default(true),
  anchors: z.array(anchorInput).max(20).default([]),
});

const patchBody = z
  .object({
    content: z.string().trim().min(1).max(10_000),
    pathPrefix: z.string().min(1).nullable(),
    pinned: z.boolean(),
    tags: z.array(tagSchema).max(10),
    /** Needed when removing "practice": where the memory goes back to. */
    project: projectRef,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

const statuses = ["active", "possibly_stale", "superseded", "retired"] as const;

const listQuery = z.object({
  scope: z.enum(["user", "project"]).optional(),
  project: z.string().min(1).optional(),
  status: z.enum(statuses).optional(),
  pinned: z.enum(["true", "false"]).optional(),
  tag: tagSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The API shape of a memory. Leaves out the embedding and search vector. */
export type AnchorDto = {
  id: string;
  path: string;
  symbol: string | null;
  commitSha: string;
};

/** Adds each memory's anchors in one query. */
export async function withAnchors<T extends { id: string }>(
  db: Db,
  items: T[],
): Promise<(T & { anchors: AnchorDto[] })[]> {
  if (items.length === 0) return [];
  const rows = await db
    .select({
      id: anchors.id,
      memoryId: anchors.memoryId,
      path: anchors.path,
      symbol: anchors.symbol,
      commitSha: anchors.commitSha,
    })
    .from(anchors)
    .where(
      inArray(
        anchors.memoryId,
        items.map((i) => i.id),
      ),
    )
    .orderBy(anchors.createdAt, anchors.path, anchors.id);
  const by = new Map<string, AnchorDto[]>();
  for (const { memoryId, ...a } of rows)
    by.set(memoryId, [...(by.get(memoryId) ?? []), a]);
  return items.map((i) => ({ ...i, anchors: by.get(i.id) ?? [] }));
}

export function toDto(m: MemoryRow, projectKey: string | null) {
  return {
    id: m.id,
    scope: m.scope,
    project: projectKey,
    owner: m.owner,
    content: m.content,
    pathPrefix: m.pathPrefix,
    status: m.status,
    staleReason: m.staleReason,
    confidence: m.confidence,
    pinned: m.pinned,
    tags: m.tags,
    author: m.author,
    agent: m.agent,
    sessionId: m.sessionId,
    supersededBy: m.supersededBy,
    embeddingModel: m.embeddingModel,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

const bad = (message: string) => ({ error: message });

/**
 * Embeds a memory's content and stores the vector with its model and dimension.
 * Failure is logged, not thrown: the memory is already saved and stays findable
 * by full text, and a later re-embed can fill the vector in.
 */
export async function embedMemory(
  db: Db,
  providers: Providers,
  id: string,
  content: string,
) {
  try {
    const [vector] = await providers.embeddings.embed([content]);
    if (!vector) return;
    await db
      .update(memories)
      .set({
        embedding: vector,
        embeddingModel: providers.embeddings.model,
        embeddingDim: providers.embeddings.dimensions,
      })
      .where(eq(memories.id, id));
  } catch (err) {
    console.error(
      `embedding failed for memory ${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export type CreateInput = z.infer<typeof createBody>;

/**
 * Stores a memory: scrub, embed, dedup, insert, anchors. Shared by the create
 * route and proposal acceptance. The caller validates scope and project.
 */
export async function createMemory(
  db: Db,
  providers: Providers,
  principal: string,
  b: CreateInput,
) {
  let projectId: string | null = null;
  if (b.project) {
    const name =
      b.project.name ?? b.project.key.split("/").pop() ?? b.project.key;
    const [p] = await db
      .insert(projects)
      .values({ key: b.project.key, name })
      .onConflictDoUpdate({
        target: projects.key,
        set: { key: b.project.key },
      })
      .returning();
    projectId = p?.id ?? null;
  }

  const clean = scrub(b.content);
  if (clean.redactions.length > 0 && isEmptyAfterScrub(clean.text)) {
    return {
      status: 422 as const,
      body: bad("content is only secrets or personal data, nothing was stored"),
    };
  }
  b.content = clean.text;

  // Embed first, so similar memories can be found before anything is written.
  let vector: number[] | null = null;
  try {
    vector = (await providers.embeddings.embed([b.content]))[0] ?? null;
  } catch (err) {
    console.error(
      "embedding failed on create:",
      err instanceof Error ? err.message : err,
    );
  }

  let supersedes: string[] = [];
  if (b.dedup && vector) {
    const candidates = await findCandidates(
      db,
      { scope: b.scope, projectId, owner: principal },
      vector,
    );
    const verdict = await decide(providers.llm, b.content, candidates);
    if (verdict.action === "duplicate") {
      const existing = candidates.find((c) => c.id === verdict.id);
      const merged =
        verdict.merged && verdict.merged !== existing?.content
          ? verdict.merged
          : null;
      if (merged) {
        await db
          .update(memories)
          .set({ content: merged, updatedAt: new Date() })
          .where(eq(memories.id, verdict.id));
        await embedMemory(db, providers, verdict.id, merged);
      } else {
        await db
          .update(memories)
          .set({ updatedAt: new Date() })
          .where(eq(memories.id, verdict.id));
      }
      const [row] = await db
        .select()
        .from(memories)
        .where(eq(memories.id, verdict.id));
      // The caller's anchors describe the same fact at a newer commit, so keep them.
      if (b.anchors.length > 0) {
        await db
          .insert(anchors)
          .values(b.anchors.map((a) => ({ ...a, memoryId: verdict.id })));
      }
      const [withA] = await withAnchors(db, [
        toDto(row as MemoryRow, b.project?.key ?? null),
      ]);
      return {
        status: 200 as const,
        body: {
          ...withA,
          outcome: merged ? "merged" : "duplicate",
          redactions: clean.redactions,
        },
      };
    }
    if (verdict.action === "supersede") supersedes = verdict.ids;
  }

  const [m] = await db
    .insert(memories)
    .values({
      scope: b.scope,
      projectId,
      owner: principal,
      content: b.content,
      pathPrefix: b.pathPrefix ?? null,
      pinned: b.pinned ?? false,
      tags: [...new Set(b.tags)],
      confidence: b.confidence,
      author: principal,
      agent: b.agent,
      sessionId: b.sessionId,
      ...(vector
        ? {
            embedding: vector,
            embeddingModel: providers.embeddings.model,
            embeddingDim: providers.embeddings.dimensions,
          }
        : {}),
    })
    .returning();
  const created = m as MemoryRow;
  if (b.anchors.length > 0) {
    await db
      .insert(anchors)
      .values(b.anchors.map((a) => ({ ...a, memoryId: created.id })));
  }
  if (supersedes.length > 0) await markSuperseded(db, supersedes, created.id);
  const [createdDto] = await withAnchors(db, [
    toDto(created, b.project?.key ?? null),
  ]);
  return {
    status: 201 as const,
    body: {
      ...createdDto,
      outcome: supersedes.length > 0 ? "superseded" : "created",
      supersedes,
      redactions: clean.redactions,
    },
  };
}

export function memoryRoutes(db: Db, providers: Providers) {
  const app = new Hono<AuthEnv>();

  async function projectKeyOf(id: string | null): Promise<string | null> {
    if (!id) return null;
    const [p] = await db
      .select({ key: projects.key })
      .from(projects)
      .where(eq(projects.id, id));
    return p?.key ?? null;
  }

  /** A user memory is visible only to its owner. Project memories are visible to every token. */
  async function findVisible(id: string, principal: string) {
    const [m] = await db.select().from(memories).where(eq(memories.id, id));
    if (!m || (m.scope === "user" && m.owner !== principal)) return null;
    return m;
  }

  app.post("/", async (c) => {
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad(z.prettifyError(parsed.error)), 400);
    const b = parsed.data;

    if (b.scope === "project" && !b.project) {
      return c.json(bad("project is required for project scope"), 400);
    }
    if (b.scope === "user" && b.project) {
      return c.json(bad("project must be omitted for user scope"), 400);
    }
    const r = await createMemory(db, providers, c.get("principal"), b);
    return c.json(r.body, r.status);
  });

  app.get("/review", async (c) => {
    const principal = c.get("principal");
    const rows = await db
      .select({ m: memories, projectKey: projects.key })
      .from(memories)
      .leftJoin(projects, eq(memories.projectId, projects.id))
      .where(
        and(
          eq(memories.status, "possibly_stale"),
          or(
            eq(memories.scope, "project"),
            and(eq(memories.scope, "user"), eq(memories.owner, principal)),
          ),
        ),
      )
      .orderBy(memories.updatedAt, memories.id)
      .limit(200);
    return c.json({
      items: await withAnchors(
        db,
        rows.map((r) => toDto(r.m, r.projectKey)),
      ),
    });
  });

  app.get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(bad(z.prettifyError(parsed.error)), 400);
    const q = parsed.data;
    const principal = c.get("principal");

    const where: SQL[] = [
      or(
        eq(memories.scope, "project"),
        and(eq(memories.scope, "user"), eq(memories.owner, principal)),
      ) as SQL,
    ];
    if (q.scope) where.push(eq(memories.scope, q.scope));
    if (q.status) where.push(eq(memories.status, q.status));
    else
      where.push(
        ne(memories.status, "retired"),
        ne(memories.status, "superseded"),
      );
    if (q.pinned) where.push(eq(memories.pinned, q.pinned === "true"));
    if (q.tag) where.push(sql`${q.tag} = ANY(${memories.tags})`);
    if (q.project) {
      const [p] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.key, q.project));
      // Your user-scoped memories (practices) belong to no project and apply in all of them.
      where.push(
        p
          ? (or(
              eq(memories.projectId, p.id),
              and(eq(memories.scope, "user"), isNull(memories.projectId)),
            ) as SQL)
          : (and(
              eq(memories.scope, "user"),
              isNull(memories.projectId),
            ) as SQL),
      );
    }

    const rows = await db
      .select({ m: memories, projectKey: projects.key })
      .from(memories)
      .leftJoin(projects, eq(memories.projectId, projects.id))
      .where(and(...where))
      .orderBy(desc(memories.createdAt), desc(memories.id))
      .limit(q.limit)
      .offset(q.offset);
    return c.json({
      items: await withAnchors(
        db,
        rows.map((r) => toDto(r.m, r.projectKey)),
      ),
      limit: q.limit,
      offset: q.offset,
    });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json(bad("not found"), 404);
    const m = await findVisible(id, c.get("principal"));
    if (!m) return c.json(bad("not found"), 404);
    const [dto] = await withAnchors(db, [
      toDto(m, await projectKeyOf(m.projectId)),
    ]);
    return c.json(dto);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json(bad("not found"), 404);
    const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad(z.prettifyError(parsed.error)), 400);
    const existing = await findVisible(id, c.get("principal"));
    if (!existing) return c.json(bad("not found"), 404);
    if (existing.status === "superseded") {
      return c.json(
        bad("superseded memories are history and can't be edited"),
        409,
      );
    }

    const b = parsed.data;
    if (b.content !== undefined) {
      const clean = scrub(b.content);
      if (clean.redactions.length > 0 && isEmptyAfterScrub(clean.text)) {
        return c.json(
          bad("content is only secrets or personal data, nothing was stored"),
          422,
        );
      }
      b.content = clean.text;
    }
    const contentChanged =
      b.content !== undefined && b.content !== existing.content;
    // The "practice" tag is what makes a memory yours everywhere: adding it moves
    // the memory to user scope, removing it moves it back to the given project.
    const principal = c.get("principal");
    const wasPractice = existing.tags.includes(PRACTICE_TAG);
    const isPractice = b.tags?.includes(PRACTICE_TAG);
    let move: { scope: "user" | "project"; projectId: string | null } | null =
      null;
    if (b.tags && isPractice && existing.scope === "project") {
      if (existing.owner !== principal) {
        return c.json(bad("only the author can make a memory a practice"), 403);
      }
      move = { scope: "user", projectId: null };
    } else if (
      b.tags &&
      !isPractice &&
      wasPractice &&
      existing.scope === "user"
    ) {
      if (!b.project) {
        return c.json(
          bad("project is required to remove the practice tag"),
          400,
        );
      }
      const name =
        b.project.name ?? b.project.key.split("/").pop() ?? b.project.key;
      const [p] = await db
        .insert(projects)
        .values({ key: b.project.key, name })
        .onConflictDoUpdate({
          target: projects.key,
          set: { key: b.project.key },
        })
        .returning();
      move = { scope: "project", projectId: p?.id ?? null };
    }
    const { project: _p, ...fields } = b;
    const [m] = await db
      .update(memories)
      .set({
        ...fields,
        // A path prefix is a place in one repo, meaningless once a memory applies everywhere.
        ...(move?.scope === "user" ? { pathPrefix: null } : {}),
        ...(move ?? {}),
        ...(b.tags ? { tags: [...new Set(b.tags)] } : {}),
        updatedAt: new Date(),
        // Rewriting a flagged memory is the "update" review outcome.
        ...(contentChanged && existing.status === "possibly_stale"
          ? { status: "active" as const, staleReason: null }
          : {}),
        // The old vector describes the old text. Clear it so search never ranks on stale meaning.
        ...(contentChanged
          ? { embedding: null, embeddingModel: null, embeddingDim: null }
          : {}),
      })
      .where(eq(memories.id, id))
      .returning();
    let row = m as MemoryRow;
    if (contentChanged) {
      await embedMemory(db, providers, id, row.content);
      const [fresh] = await db
        .select()
        .from(memories)
        .where(eq(memories.id, id));
      row = fresh ?? row;
    }
    const [dto] = await withAnchors(db, [
      toDto(row, await projectKeyOf(row.projectId)),
    ]);
    return c.json(dto);
  });

  /**
   * Records the result of an anchor check done against a checkout. The server
   * has no repo, so the client verifies (see `verifyAnchors` in shared) and
   * reports here. `stale: false` clears a possibly_stale flag, e.g. after review.
   */
  app.put("/:id/staleness", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json(bad("not found"), 404);
    const parsed = z
      .discriminatedUnion("stale", [
        z.object({
          stale: z.literal(true),
          reason: z.string().trim().min(1).max(1000),
        }),
        z.object({ stale: z.literal(false) }),
      ])
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad(z.prettifyError(parsed.error)), 400);
    const existing = await findVisible(id, c.get("principal"));
    if (!existing) return c.json(bad("not found"), 404);
    if (existing.status !== "active" && existing.status !== "possibly_stale") {
      return c.json(
        bad(`a ${existing.status} memory can't change staleness`),
        409,
      );
    }
    const b = parsed.data;
    const [m] = await db
      .update(memories)
      .set(
        b.stale
          ? {
              status: "possibly_stale",
              staleReason: b.reason,
              updatedAt: new Date(),
            }
          : { status: "active", staleReason: null, updatedAt: new Date() },
      )
      .where(eq(memories.id, id))
      .returning();
    const row = m as MemoryRow;
    const [dto] = await withAnchors(db, [
      toDto(row, await projectKeyOf(row.projectId)),
    ]);
    return c.json(dto);
  });

  /** Retires the memory (kept as history). `?hard=true` deletes the row. */
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json(bad("not found"), 404);
    const existing = await findVisible(id, c.get("principal"));
    if (!existing) return c.json(bad("not found"), 404);

    if (c.req.query("hard") === "true") {
      await db.delete(memories).where(eq(memories.id, id));
      return c.body(null, 204);
    }
    const [m] = await db
      .update(memories)
      .set({ status: "retired", updatedAt: new Date() })
      .where(eq(memories.id, id))
      .returning();
    return c.json(
      toDto(m as MemoryRow, await projectKeyOf((m as MemoryRow).projectId)),
    );
  });

  return app;
}
