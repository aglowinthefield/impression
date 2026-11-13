import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { projectIdCond, upsertProject } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { projects, sessions } from "./db/schema.js";
import {
  candidatesSchema,
  extractProposals,
  type SessionCandidate,
} from "./extract.js";
import type { Providers } from "./providers/index.js";
import { scrub } from "./scrub.js";

/** About 2 MB of text. Longer transcripts should be summarized by the client first. */
export const MAX_TRANSCRIPT_CHARS = 2_000_000;

/** Instruction text sent with an extract request. Longer input is cut. */
export const MAX_INSTRUCTIONS_CHARS = 20_000;

const extractBody = z.object({
  instructions: z.string().trim().min(1).optional(),
});

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
  /** Repos the session's tool calls touched. Bad data is dropped, not a failed upload. */
  candidates: candidatesSchema.optional().catch(undefined),
});

/** `path:` projects are local to one machine, so they never take another session's memories. */
function storedCandidates(list: SessionCandidate[] | undefined) {
  const kept = (list ?? []).filter((c) => !c.key.startsWith("path:"));
  return kept.length ? kept : null;
}

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
    const p = await upsertProject(db, c.get("access"), b.project);
    if (!p) return c.json({ error: "project not found" }, 404);
    // A hook that fires twice (two plugins, or a plugin beside an old setup hook)
    // sends the same chunk twice. Hand back the first copy, so it's stored and
    // extracted once.
    const [dup] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, p.id),
          eq(sessions.owner, c.get("principal")),
          eq(sessions.transcript, clean.text),
          gt(sessions.createdAt, sql`now() - interval '1 day'`),
        ),
      )
      .limit(1);
    if (dup)
      return c.json({ ...dto(dup, b.project.key), duplicate: true }, 200);
    const [s] = await db
      .insert(sessions)
      .values({
        projectId: p.id,
        owner: c.get("principal"),
        agent: b.agent,
        commitSha: b.commitSha,
        transcript: clean.text,
        candidates: storedCandidates(b.candidates),
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
          await projectIdCond(db, c.get("access"), sessions.projectId),
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
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.owner, c.get("principal")),
          await projectIdCond(db, c.get("access"), sessions.projectId),
        ),
      );
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(dto(r.s, r.key));
  });

  /** Runs extraction on a stored session and stores what it finds as memories. */
  app.post("/:id/extract", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success)
      return c.json({ error: "not found" }, 404);
    const [s] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.owner, c.get("principal")),
          await projectIdCond(db, c.get("access"), sessions.projectId),
        ),
      );
    if (!s) return c.json({ error: "not found" }, 404);
    const parsed = extractBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request" }, 400);
    // Scrub like the transcript: instruction files can hold paths or keys.
    const instructions = parsed.data.instructions
      ? scrub(parsed.data.instructions.slice(0, MAX_INSTRUCTIONS_CHARS)).text
      : undefined;
    try {
      const summary = await extractProposals(db, providers, {
        sessionId: s.id,
        projectId: s.projectId,
        projectKey: (
          await db
            .select({ key: projects.key })
            .from(projects)
            .where(eq(projects.id, s.projectId))
        )[0]?.key as string,
        owner: s.owner,
        commitSha: s.commitSha,
        transcript: s.transcript,
        candidates: candidatesSchema.catch([]).parse(s.candidates ?? []),
        access: c.get("access"),
        ...(instructions ? { instructions } : {}),
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
