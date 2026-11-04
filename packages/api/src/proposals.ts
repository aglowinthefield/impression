import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { projects, proposals } from "./db/schema.js";
import { acceptProposal } from "./extract.js";
import type { Providers } from "./providers/index.js";

type Row = typeof proposals.$inferSelect;

function dto(p: Row, projectKey: string) {
  return {
    id: p.id,
    project: projectKey,
    sessionId: p.sessionId,
    content: p.content,
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
 * Proposals belong to a project, and project memories are shared, so any token
 * can review them. Rejections stay in the table: extraction compares new
 * candidates against them and doesn't propose the same thing again.
 */
export function proposalRoutes(db: Db, providers: Providers) {
  const app = new Hono<AuthEnv>();

  async function find(id: string) {
    if (!z.uuid().safeParse(id).success) return null;
    const [r] = await db
      .select({ p: proposals, key: projects.key })
      .from(proposals)
      .innerJoin(projects, eq(proposals.projectId, projects.id))
      .where(eq(proposals.id, id));
    return r ?? null;
  }

  app.get("/", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const q = parsed.data;
    const rows = await db
      .select({ p: proposals, key: projects.key })
      .from(proposals)
      .innerJoin(projects, eq(proposals.projectId, projects.id))
      .where(
        and(
          eq(proposals.status, q.status),
          q.project ? eq(projects.key, q.project) : undefined,
        ),
      )
      .orderBy(desc(proposals.confidence), desc(proposals.createdAt))
      .limit(q.limit);
    return c.json({ items: rows.map((r) => dto(r.p, r.key)) });
  });

  app.get("/:id", async (c) => {
    const r = await find(c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(dto(r.p, r.key));
  });

  /** Accepts the proposal as a project memory. Body `{content}` edits the text first. */
  app.post("/:id/accept", async (c) => {
    const r = await find(c.req.param("id"));
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
    return c.json(result.body, result.status);
  });

  app.post("/:id/reject", async (c) => {
    const r = await find(c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const [p] = await db
      .update(proposals)
      .set({ status: "rejected" })
      .where(and(eq(proposals.id, r.p.id), eq(proposals.status, "pending")))
      .returning();
    if (!p) return c.json({ error: `proposal is already ${r.p.status}` }, 409);
    return c.json(dto(p, r.key));
  });

  return app;
}
