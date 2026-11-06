import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Access, projectIdCond } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { projects, proposals, sessions } from "./db/schema.js";
import { acceptProposal } from "./extract.js";
import type { Providers } from "./providers/index.js";

/** How much of the source session the review queue shows. */
const EXCERPT_CHARS = 600;

type Row = typeof proposals.$inferSelect;

function dto(p: Row, projectKey: string) {
  return {
    id: p.id,
    project: projectKey,
    sessionId: p.sessionId,
    content: p.content,
    scope: p.scope,
    tags: p.tags,
    confidence: p.confidence,
    anchors: p.anchors,
    status: p.status,
    memoryId: p.memoryId,
    createdAt: p.createdAt,
  };
}

const listQuery = z.object({
  project: z.string().min(1).optional(),
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const acceptBody = z.object({
  content: z.string().trim().min(1).max(10_000).optional(),
});

/**
 * A proposal comes from one person's session, so only that person reviews it.
 * Rejections stay in the table: extraction compares new
 * candidates against them and doesn't propose the same thing again.
 */
export function proposalRoutes(db: Db, providers: Providers) {
  const app = new Hono<AuthEnv>();

  async function find(id: string, me: string, a: Access) {
    if (!z.uuid().safeParse(id).success) return null;
    const [r] = await db
      .select({ p: proposals, key: projects.key, owner: sessions.owner })
      .from(proposals)
      .innerJoin(projects, eq(proposals.projectId, projects.id))
      .leftJoin(sessions, eq(proposals.sessionId, sessions.id))
      .where(
        and(
          eq(proposals.id, id),
          eq(sessions.owner, me),
          await projectIdCond(db, a, proposals.projectId),
        ),
      );
    return r ?? null;
  }

  app.get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const q = parsed.data;
    const rows = await db
      .select({
        p: proposals,
        key: projects.key,
        owner: sessions.owner,
        head: sql<
          string | null
        >`left(${sessions.transcript}, ${EXCERPT_CHARS})`,
      })
      .from(proposals)
      .innerJoin(projects, eq(proposals.projectId, projects.id))
      .leftJoin(sessions, eq(proposals.sessionId, sessions.id))
      .where(
        and(
          eq(proposals.status, q.status),
          eq(sessions.owner, c.get("principal")),
          await projectIdCond(db, c.get("access"), proposals.projectId),
          q.project ? eq(projects.key, q.project) : undefined,
        ),
      )
      .orderBy(desc(proposals.confidence), desc(proposals.createdAt))
      .limit(q.limit);
    const me = c.get("principal");
    return c.json({
      items: rows.map((r) => ({
        ...dto(r.p, r.key),
        // Transcripts are private to whoever ended the session.
        sessionExcerpt: r.owner === me ? r.head : null,
      })),
    });
  });

  app.get("/:id", async (c) => {
    const r = await find(
      c.req.param("id"),
      c.get("principal"),
      c.get("access"),
    );
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(dto(r.p, r.key));
  });

  /** Accepts the proposal as a project memory. Body `{content}` edits the text first. */
  app.post("/:id/accept", async (c) => {
    const r = await find(
      c.req.param("id"),
      c.get("principal"),
      c.get("access"),
    );
    if (!r) return c.json({ error: "not found" }, 404);
    const parsed = acceptBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const result = await acceptProposal(
      db,
      providers,
      r.p.id,
      c.get("principal"),
      {
        projectKey: r.key,
        content: parsed.data.content,
      },
    );
    if (!result)
      return c.json({ error: `proposal is already ${r.p.status}` }, 409);
    if (result.status !== 422)
      await db
        .update(proposals)
        .set({ reviewedAt: new Date() })
        .where(eq(proposals.id, r.p.id));
    return c.json(result.body, result.status);
  });

  app.post("/:id/reject", async (c) => {
    const r = await find(
      c.req.param("id"),
      c.get("principal"),
      c.get("access"),
    );
    if (!r) return c.json({ error: "not found" }, 404);
    const [p] = await db
      .update(proposals)
      .set({ status: "rejected", reviewedAt: new Date() })
      .where(and(eq(proposals.id, r.p.id), eq(proposals.status, "pending")))
      .returning();
    if (!p) return c.json({ error: `proposal is already ${r.p.status}` }, 409);
    return c.json(dto(p, r.key));
  });

  return app;
}
