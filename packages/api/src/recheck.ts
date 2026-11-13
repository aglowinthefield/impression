import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { findProject, memoryVisible } from "./access.js";
import type { AuthEnv } from "./auth.js";
import type { Db } from "./db/client.js";
import { anchors, memories, memoryEvents, projects } from "./db/schema.js";
import {
  anchorInput,
  anchorPath,
  createMemory,
  toDto,
  withAnchors,
} from "./memories.js";
import type { LlmProvider, Providers } from "./providers/index.js";
import { markSuperseded } from "./reconcile.js";
import { withUsageContext } from "./usage.js";

type MemoryRow = typeof memories.$inferSelect;

/** Total file text shown to the model. Keeps one recheck to a few cents at most. */
export const MAX_EXCERPT_CHARS = 40_000;

export type RecheckVerdict =
  | { action: "keep" }
  | { action: "rewrite"; content: string }
  | { action: "retire"; why?: string };

const verdictSchema = z.union([
  z.object({ action: z.literal("keep") }),
  z.object({
    action: z.literal("rewrite"),
    content: z.string().trim().min(1).max(10_000),
  }),
  z.object({
    action: z.literal("retire"),
    why: z.string().trim().max(1000).optional(),
  }),
]);

const SYSTEM = `You check whether a saved memory about a codebase is still true. Files it depends on changed since it was written. Read the memory and the current files, then decide:
- "keep": the memory is still accurate.
- "rewrite": part of it is out of date. Put the corrected memory in "content", in the same style and about the same length, saying only what the files support.
- "retire": it is no longer true or no longer matters, and nothing in it is worth keeping. Say why in "why".
A file marked deleted no longer exists. Long files are cut short, so a part you can't see is not evidence it was removed. When the files don't settle it, answer "keep". Reply with one JSON object and nothing else:
{"action":"keep"} | {"action":"rewrite","content":"..."} | {"action":"retire","why":"..."}`;

export interface FileState {
  path: string;
  /** Null when the file was deleted. */
  content: string | null;
}

/**
 * Fits the files into `total` characters. Short files are shown whole and what they
 * leave unused goes to the longer ones, which keep their beginning.
 */
export function excerpts(
  files: FileState[],
  total = MAX_EXCERPT_CHARS,
): string[] {
  const share = new Map<number, number>();
  const order = files
    .map((f, i) => ({ i, len: f.content?.length ?? 0 }))
    .sort((a, b) => a.len - b.len);
  let left = total;
  order.forEach(({ i, len }, n) => {
    const fair = Math.floor(left / (order.length - n));
    const take = Math.min(len, fair);
    share.set(i, take);
    left -= take;
  });
  return files.map((f, i) => {
    if (f.content === null) return `--- ${f.path} (deleted)`;
    const take = share.get(i) ?? 0;
    const cut = f.content.length - take;
    return `--- ${f.path}\n${f.content.slice(0, take)}${
      cut > 0 ? `\n[... ${cut} more characters not shown]` : ""
    }`;
  });
}

export function buildRecheckPrompt(
  memory: string,
  reason: string,
  files: FileState[],
): string {
  return `Memory:\n${memory}\n\nWhy it is being checked: ${reason}\n\nCurrent files:\n${excerpts(files).join("\n\n")}`;
}

/** The first JSON object in the reply if it is a verdict, else null. */
export function parseRecheck(reply: string): RecheckVerdict | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = verdictSchema.safeParse(
      JSON.parse(reply.slice(start, end + 1)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Asks the model. Throws on a provider error or a reply that isn't a verdict. */
export async function askRecheck(
  llm: LlmProvider,
  memory: string,
  reason: string,
  files: FileState[],
): Promise<RecheckVerdict> {
  const reply = await llm.complete({
    system: SYSTEM,
    prompt: buildRecheckPrompt(memory, reason, files),
    maxTokens: 1000,
  });
  const v = parseRecheck(reply);
  if (!v) throw new Error("the model gave no verdict");
  return v;
}

const recheckBody = z.object({
  reason: z.string().trim().min(1).max(1000),
  commitSha: anchorInput.shape.commitSha,
  files: z
    .array(
      z.object({
        path: anchorPath,
        content: z.string().max(1_000_000).nullable(),
      }),
    )
    .min(1)
    .max(20),
});

const bad = (message: string) => ({ error: message });

/**
 * The automatic staleness check. The client runs `verifyAnchors` against its
 * checkout, since the server has no repo, and sends the changed files here.
 * Mounted under /memories before `memoryRoutes`, whose `/:id` would catch `/anchored`.
 */
export function recheckRoutes(db: Db, providers: Providers) {
  const app = new Hono<AuthEnv>();

  /** Your anchored memories in a project that could still go stale, oldest touched first. */
  app.get("/anchored", async (c) => {
    const key = c.req.query("project");
    if (!key) return c.json(bad("project is required"), 400);
    const p = await findProject(db, c.get("access"), key);
    if (!p) return c.json({ items: [] });
    const rows = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.owner, c.get("principal")),
          eq(memories.projectId, p.id),
          inArray(memories.status, ["active", "possibly_stale"]),
          exists(
            db
              .select({ one: sql`1` })
              .from(anchors)
              .where(eq(anchors.memoryId, memories.id)),
          ),
        ),
      )
      .orderBy(memories.updatedAt, memories.id)
      .limit(500);
    return c.json({
      items: await withAnchors(
        db,
        rows.map((m) => toDto(m, p.key)),
      ),
    });
  });

  app.post("/:id/recheck", async (c) => {
    const id = c.req.param("id");
    if (!z.uuid().safeParse(id).success) return c.json(bad("not found"), 404);
    const parsed = recheckBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(bad(z.prettifyError(parsed.error)), 400);
    const principal = c.get("principal");
    const [m] = await db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.id, id),
          await memoryVisible(db, c.get("access"), principal),
        ),
      );
    if (!m) return c.json(bad("not found"), 404);
    // A rewrite makes a new memory in the caller's name, so only the author may recheck.
    if (m.owner !== principal) {
      return c.json(bad("only the author can recheck a memory"), 403);
    }
    if (m.status !== "active" && m.status !== "possibly_stale") {
      return c.json(bad(`a ${m.status} memory can't be rechecked`), 409);
    }
    const b = parsed.data;
    const usage = {
      userId: c.get("access")?.userId ?? null,
      principal,
      operation: "recheck",
    };

    let verdict: RecheckVerdict;
    try {
      verdict = await withUsageContext(usage, () =>
        askRecheck(providers.llm, m.content, b.reason, b.files),
      );
    } catch (err) {
      // Never retire on a failed check: the memory stays as it was.
      return c.json(
        bad(`recheck failed: ${err instanceof Error ? err.message : err}`),
        502,
      );
    }
    if (verdict.action === "rewrite" && verdict.content === m.content)
      verdict = { action: "keep" };

    const projectKey = await keyOf(db, m.projectId);
    // An anchor on a deleted file can only ever read as stale, so it goes.
    const deleted = b.files
      .filter((f) => f.content === null)
      .map((f) => f.path);
    const detail = {
      commitSha: b.commitSha,
      files: b.files.map((f) => f.path),
    };

    if (verdict.action === "keep") {
      if (deleted.length > 0) {
        await db
          .delete(anchors)
          .where(and(eq(anchors.memoryId, id), inArray(anchors.path, deleted)));
      }
      await db
        .update(anchors)
        .set({ commitSha: b.commitSha })
        .where(eq(anchors.memoryId, id));
      const row = await setStatus(db, id, "active");
      await record(db, id, "kept", b.reason, detail);
      const [memory] = await withAnchors(db, [toDto(row, projectKey)]);
      return c.json({ outcome: "kept", memory });
    }

    if (verdict.action === "retire") {
      const row = await setStatus(db, id, "retired");
      await record(db, id, "retired", b.reason, {
        ...detail,
        why: verdict.why ?? null,
      });
      const [memory] = await withAnchors(db, [toDto(row, projectKey)]);
      return c.json({ outcome: "retired", memory });
    }

    const [old] = await withAnchors(db, [toDto(m, projectKey)]);
    const seen = new Set<string>();
    const moved = (old?.anchors ?? []).flatMap((a) => {
      const k = `${a.path}\0${a.symbol ?? ""}`;
      if (deleted.includes(a.path) || seen.has(k)) return [];
      seen.add(k);
      return [
        {
          path: a.path,
          ...(a.symbol ? { symbol: a.symbol } : {}),
          commitSha: b.commitSha,
        },
      ];
    });
    const r = await withUsageContext(usage, () =>
      createMemory(db, providers, principal, {
        // Team is a sharing flag on a project memory; it is set back below.
        scope: m.scope === "user" ? "user" : "project",
        content: verdict.content,
        ...(projectKey ? { project: { key: projectKey } } : {}),
        pathPrefix: m.pathPrefix,
        pinned: m.pinned,
        tags: m.tags,
        confidence: m.confidence ?? undefined,
        agent: m.agent ?? undefined,
        sessionId: m.sessionId ?? undefined,
        // The model already compared the new text with the memory it replaces, and the
        // dedup check would mostly match that same memory.
        dedup: false,
        anchors: moved.slice(0, 20),
      }),
    );
    if (r.status !== 201) return c.json(r.body, r.status);
    const newId = r.body.id;
    if (!newId) return c.json(bad("the rewrite was not stored"), 500);
    if (m.scope === "team") {
      await db
        .update(memories)
        .set({ scope: "team" })
        .where(eq(memories.id, newId));
    }
    await markSuperseded(db, [id], newId);
    await record(db, id, "rewritten", b.reason, {
      ...detail,
      replacement: newId,
      content: verdict.content,
    });
    const [after] = await db.select().from(memories).where(eq(memories.id, id));
    const [fresh] = await db
      .select()
      .from(memories)
      .where(eq(memories.id, newId));
    const [memory, replacement] = await withAnchors(db, [
      toDto(after as MemoryRow, projectKey),
      toDto(fresh as MemoryRow, projectKey),
    ]);
    return c.json({ outcome: "rewritten", memory, replacement });
  });

  return app;
}

async function keyOf(db: Db, projectId: string | null) {
  if (!projectId) return null;
  const [p] = await db
    .select({ key: projects.key })
    .from(projects)
    .where(eq(projects.id, projectId));
  return p?.key ?? null;
}

async function setStatus(db: Db, id: string, status: "active" | "retired") {
  const [row] = await db
    .update(memories)
    .set({ status, staleReason: null, updatedAt: new Date() })
    .where(eq(memories.id, id))
    .returning();
  return row as MemoryRow;
}

function record(
  db: Db,
  memoryId: string,
  kind: "kept" | "rewritten" | "retired",
  reason: string,
  detail: Record<string, unknown>,
) {
  return db.insert(memoryEvents).values({ memoryId, kind, reason, detail });
}
