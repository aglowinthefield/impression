import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import {
  evalTurns,
  memories,
  memoryRatings,
  projects,
  sessions,
} from "./db/schema.js";
import { scrub } from "./scrub.js";

const INJECTION_RATINGS = ["useful", "irrelevant", "wrong"] as const;
const EXTRACTION_RATINGS = ["good", "junk"] as const;
const MAX_TURNS_PER_PUSH = 500;

const pushBody = z.object({
  turns: z
    .array(
      z.object({
        project: z.object({
          key: z.string().min(1),
          name: z.string().optional(),
        }),
        agentSessionId: z.string().min(1),
        turnIndex: z.number().int().min(0),
        prompt: z.string().max(20_000),
        reply: z.string().max(2_000),
        injected: z.array(z.string().max(4_000)).max(100),
        at: z.string().datetime().nullable().optional(),
      }),
    )
    .max(MAX_TURNS_PER_PUSH),
});

const turnsQuery = z.object({
  project: z.string().optional(),
  /** Only turns that had memories injected. Default true. */
  injectedOnly: z.enum(["true", "false"]).default("true"),
  /** Only turns with at least one memory still unrated. */
  unrated: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function evalRoutes(db: Db) {
  const app = new Hono<AuthEnv>();

  /** Uploads turns. Re-pushing updates the text but keeps ratings already given. */
  app.post("/turns", async (c) => {
    const parsed = pushBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const owner = c.get("principal");
    const projectIds = new Map<string, string>();
    for (const t of parsed.data.turns) {
      const key = t.project.key;
      if (projectIds.has(key)) continue;
      const [p] = await db
        .insert(projects)
        .values({ key, name: t.project.name ?? key.split("/").pop() ?? key })
        .onConflictDoUpdate({ target: projects.key, set: { key } })
        .returning();
      projectIds.set(key, (p as { id: string }).id);
    }
    let stored = 0;
    for (const t of parsed.data.turns) {
      await db
        .insert(evalTurns)
        .values({
          owner,
          projectId: projectIds.get(t.project.key),
          agentSessionId: t.agentSessionId,
          turnIndex: t.turnIndex,
          prompt: scrub(t.prompt).text,
          reply: scrub(t.reply).text,
          injected: t.injected,
          at: t.at ? new Date(t.at) : null,
        })
        .onConflictDoUpdate({
          target: [
            evalTurns.owner,
            evalTurns.agentSessionId,
            evalTurns.turnIndex,
          ],
          set: {
            prompt: scrub(t.prompt).text,
            reply: scrub(t.reply).text,
            injected: t.injected,
          },
        });
      stored++;
    }
    return c.json({ stored });
  });

  app.get("/turns", async (c) => {
    const parsed = turnsQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const q = parsed.data;
    const where = [eq(evalTurns.owner, c.get("principal"))];
    if (q.project)
      where.push(
        sql`${evalTurns.projectId} = (SELECT id FROM projects WHERE key = ${q.project})`,
      );
    if (q.injectedOnly === "true")
      where.push(sql`jsonb_array_length(${evalTurns.injected}) > 0`);
    if (q.unrated === "true")
      where.push(
        sql`(SELECT count(*) FROM jsonb_array_elements_text(${evalTurns.injected}) m WHERE NOT ${evalTurns.ratings} ? m) > 0`,
      );
    const rows = await db
      .select()
      .from(evalTurns)
      .where(and(...where))
      .orderBy(desc(evalTurns.at), desc(evalTurns.createdAt))
      .limit(q.limit);
    const texts = [...new Set(rows.flatMap((r) => r.injected))];
    const known = texts.length
      ? await db
          .select({
            id: memories.id,
            content: memories.content,
            status: memories.status,
          })
          .from(memories)
          .where(inArray(memories.content, texts))
      : [];
    const byText = new Map(known.map((m) => [m.content, m]));
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        at: r.at,
        prompt: r.prompt,
        reply: r.reply,
        // Stored rows may repeat a memory (core set + per-prompt search);
        // ratings are keyed by text, so show each once.
        injected: [...new Set(r.injected)].map((text) => ({
          text,
          memoryId: byText.get(text)?.id ?? null,
          status: byText.get(text)?.status ?? null,
          rating: r.ratings[text] ?? null,
        })),
      })),
    });
  });

  const ratingBody = z.object({
    memory: z.string().min(1),
    rating: z.enum(INJECTION_RATINGS).nullable(),
  });
  app.put("/turns/:id/rating", async (c) => {
    const parsed = ratingBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const { memory, rating } = parsed.data;
    const where = and(
      eq(evalTurns.id, c.req.param("id")),
      eq(evalTurns.owner, c.get("principal")),
    );
    const [turn] = await db.select().from(evalTurns).where(where);
    if (!turn || !turn.injected.includes(memory))
      return c.json({ error: "not found" }, 404);
    const ratings = { ...turn.ratings };
    if (rating) ratings[memory] = rating;
    else delete ratings[memory];
    await db.update(evalTurns).set({ ratings }).where(where);
    return c.json({ ok: true });
  });

  /** Per memory: how often it was injected and how it was rated. */
  app.get("/memories", async (c) => {
    const owner = c.get("principal");
    const key = c.req.query("project");
    const [project] = key
      ? await db.select().from(projects).where(eq(projects.key, key))
      : [];
    if (key && !project) return c.json({ items: [] });
    const scope = or(
      project
        ? and(eq(memories.scope, "project"), eq(memories.projectId, project.id))
        : eq(memories.scope, "project"),
      and(eq(memories.scope, "user"), eq(memories.owner, owner)),
    );
    const mems = await db
      .select({
        id: memories.id,
        content: memories.content,
        pinned: memories.pinned,
      })
      .from(memories)
      .where(and(eq(memories.status, "active"), scope));
    const turns = await db
      .select({ injected: evalTurns.injected, ratings: evalTurns.ratings })
      .from(evalTurns)
      .where(
        and(
          eq(evalTurns.owner, owner),
          project ? eq(evalTurns.projectId, project.id) : undefined,
        ),
      );
    const stats = new Map<
      string,
      { injected: number; useful: number; irrelevant: number; wrong: number }
    >();
    for (const t of turns)
      for (const text of new Set(t.injected)) {
        const s = stats.get(text) ?? {
          injected: 0,
          useful: 0,
          irrelevant: 0,
          wrong: 0,
        };
        s.injected++;
        const r = t.ratings[text];
        if (r === "useful" || r === "irrelevant" || r === "wrong") s[r]++;
        stats.set(text, s);
      }
    const items = mems.map((m) => ({
      ...m,
      ...(stats.get(m.content) ?? {
        injected: 0,
        useful: 0,
        irrelevant: 0,
        wrong: 0,
      }),
    }));
    items.sort((a, b) => b.injected - a.injected);
    return c.json({ items, turns: turns.length });
  });

  /** Memories written by extraction, newest first, with the rating you gave and the source. */
  app.get("/extraction", async (c) => {
    const owner = c.get("principal");
    const key = c.req.query("project");
    const [project] = key
      ? await db.select().from(projects).where(eq(projects.key, key))
      : [];
    if (key && !project) return c.json({ items: [] });
    const rows = await db
      .select({
        id: memories.id,
        content: memories.content,
        status: memories.status,
        createdAt: memories.createdAt,
        rating: memoryRatings.rating,
        sessionId: memories.sessionId,
      })
      .from(memories)
      .leftJoin(
        memoryRatings,
        and(
          eq(memoryRatings.memoryId, memories.id),
          eq(memoryRatings.owner, owner),
        ),
      )
      .where(
        and(
          eq(memories.agent, "extraction"),
          or(eq(memories.scope, "project"), eq(memories.owner, owner)),
          project ? eq(memories.projectId, project.id) : undefined,
        ),
      )
      .orderBy(desc(memories.createdAt))
      .limit(100);
    return c.json({ items: rows });
  });

  const extractionBody = z.object({
    rating: z.enum(EXTRACTION_RATINGS).nullable(),
  });
  app.put("/extraction/:memoryId", async (c) => {
    const parsed = extractionBody.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const owner = c.get("principal");
    const memoryId = c.req.param("memoryId");
    const [m] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.id, memoryId),
          or(eq(memories.scope, "project"), eq(memories.owner, owner)),
        ),
      );
    if (!m) return c.json({ error: "not found" }, 404);
    if (parsed.data.rating === null)
      await db
        .delete(memoryRatings)
        .where(
          and(
            eq(memoryRatings.memoryId, memoryId),
            eq(memoryRatings.owner, owner),
          ),
        );
    else
      await db
        .insert(memoryRatings)
        .values({ memoryId, owner, rating: parsed.data.rating })
        .onConflictDoUpdate({
          target: [memoryRatings.memoryId, memoryRatings.owner],
          set: { rating: parsed.data.rating },
        });
    return c.json({ ok: true });
  });

  /** The end of the transcript a memory was extracted from, to turn a junk rating into a fixture. */
  app.get("/extraction/:memoryId/source", async (c) => {
    const owner = c.get("principal");
    const [row] = await db
      .select({ transcript: sessions.transcript })
      .from(memories)
      .innerJoin(sessions, eq(sessions.id, memories.sessionId))
      .where(
        and(
          eq(memories.id, c.req.param("memoryId")),
          eq(sessions.owner, owner),
        ),
      );
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ transcriptTail: row.transcript.slice(-3000) });
  });

  return app;
}
