import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { projects, sessions } from "./db/schema.js";
import { extractProposals } from "./extract.js";
import type { Providers } from "./providers/index.js";
import { scrub } from "./scrub.js";

/** About 2 MB of text. Longer transcripts should be summarized by the client first. */
export const MAX_TRANSCRIPT_CHARS = 2_000_000;

const body = z.object({
  project: z.object({
    key: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  /** The transcript, or a summary of it. */
  transcript: z.string().trim().min(1).max(MAX_TRANSCRIPT_CHARS),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, "commitSha must be a hex git SHA")
    .optional(),
  agent: z.string().min(1).optional(),
});

function dto(
  s: typeof sessions.$inferSelect,
  projectKey: string,
  redactions?: unknown,
) {
  return {
    id: s.id,
    project: projectKey,
    owner: s.owner,
    agent: s.agent,
    commitSha: s.commitSha,
    transcriptChars: s.transcript.length,
    createdAt: s.createdAt,
    ...(redactions ? { redactions } : {}),
  };
}

export function sessionRoutes(db: Db, providers: Providers) {
  const app = new Hono<AuthEnv>();

  app.post("/", async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const b = parsed.data;

    // Scrub before storing, so raw secrets never reach the database or the extractor.
    const clean = scrub(b.transcript);
    const name =
      b.project.name ?? b.project.key.split("/").pop() ?? b.project.key;
    const [p] = await db
      .insert(projects)
      .values({ key: b.project.key, name })
      .onConflictDoUpdate({ target: projects.key, set: { key: b.project.key } })
      .returning();
    const [s] = await db
      .insert(sessions)
      .values({
        projectId: (p as { id: string }).id,
        owner: c.get("principal"),
        agent: b.agent,
        commitSha: b.commitSha,
        transcript: clean.text,
      })
      .returning();
    return c.json(
      dto(s as typeof sessions.$inferSelect, b.project.key, clean.redactions),
      201,
    );
  });

  app.get("/", async (c) => {
    const key = c.req.query("project");
    const rows = await db
      .select({ s: sessions, key: projects.key })
      .from(sessions)
      .innerJoin(projects, eq(sessions.projectId, projects.id))
      .where(
        and(
          eq(sessions.owner, c.get("principal")),
          key ? eq(projects.key, key) : undefined,
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(50);
    return c.json({ items: rows.map((r) => dto(r.s, r.key)) });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success)
      return c.json({ error: "not found" }, 404);
    const [r] = await db
      .select({ s: sessions, key: projects.key })
      .from(sessions)
      .innerJoin(projects, eq(sessions.projectId, projects.id))
      .where(and(eq(sessions.id, id), eq(sessions.owner, c.get("principal"))));
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(dto(r.s, r.key));
  });

  /** Runs extraction on a stored session and queues the results as proposals. */
  app.post("/:id/extract", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success)
      return c.json({ error: "not found" }, 404);
    const [s] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.owner, c.get("principal"))));
    if (!s) return c.json({ error: "not found" }, 404);
    try {
      const summary = await extractProposals(db, providers, {
        sessionId: s.id,
        projectId: s.projectId,
        owner: s.owner,
        commitSha: s.commitSha,
        transcript: s.transcript,
      });
      return c.json(summary);
    } catch (err) {
      console.error(
        "extraction failed:",
        err instanceof Error ? err.message : err,
      );
      return c.json({ error: "extraction failed, try again" }, 502);
    }
  });

  return app;
}
