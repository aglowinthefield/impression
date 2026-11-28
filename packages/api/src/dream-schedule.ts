import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { apiTokens, dreamRuns } from "./db/schema.js";
import { type DreamResult, dream } from "./dream.js";
import type { LlmProvider, ModelUsage } from "./providers/index.js";
import { costMicros, withUsageContext } from "./usage.js";

export type DreamTrigger = "manual" | "count" | "daily";

/** Dream once this many of a person's memories in a project changed since their last run. */
export const DREAM_EVERY = 20;
/** Fewer memories than this aren't worth grouping. */
export const MIN_DREAM_MEMORIES = 8;
/** At most one scheduled run per person and project in this window, failed runs included. */
const COOLDOWN = "1 hour";
/** How often the schedule looks for due runs. */
export const SWEEP_MS = 10 * 60_000;

/**
 * Runs one dream and records it in `dream_runs`, with what it changed and what
 * it cost. A failed run is recorded with its error and rethrown.
 */
export async function runDream(
  db: Db,
  llm: LlmProvider,
  projectId: string,
  owner: string,
  trigger: DreamTrigger,
  userId?: string | null,
): Promise<DreamResult> {
  const [run] = await db
    .insert(dreamRuns)
    .values({ projectId, owner, trigger, model: llm.model })
    .returning({ id: dreamRuns.id });
  if (!run) throw new Error("dream run insert returned nothing");
  const tally: ModelUsage[] = [];
  const cost = () => {
    const each = tally.map(costMicros);
    return each.some((c) => c === null)
      ? null
      : each.reduce<number>((n, c) => n + (c ?? 0), 0);
  };
  try {
    const result = await withUsageContext(
      {
        userId: userId === undefined ? await userOf(db, owner) : userId,
        principal: owner,
        operation: "dream",
        tally,
      },
      () => dream(db, llm, projectId, owner),
    );
    await db
      .update(dreamRuns)
      .set({ ...result, finishedAt: sql`now()`, costMicros: cost() })
      .where(eq(dreamRuns.id, run.id));
    return result;
  } catch (err) {
    await db
      .update(dreamRuns)
      .set({
        finishedAt: sql`now()`,
        costMicros: cost(),
        error: (err as Error).message.slice(0, 500),
      })
      .where(eq(dreamRuns.id, run.id));
    throw err;
  }
}

/** The GitHub user behind a principal, for usage attribution. */
export async function userOf(db: Db, owner: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: apiTokens.userId })
    .from(apiTokens)
    .where(and(eq(apiTokens.name, owner), isNotNull(apiTokens.userId)))
    .limit(1);
  return row?.userId ?? null;
}

export interface DueDream {
  projectId: string;
  owner: string;
  trigger: "count" | "daily";
}

/**
 * People and projects whose concepts are due: `every` of the memories a run
 * would read changed since their last successful run, or a day passed and at
 * least one changed. Retiring a memory counts as a change.
 */
export async function dueDreams(
  db: Db,
  every = DREAM_EVERY,
): Promise<DueDream[]> {
  const rows = await db.execute<{
    project_id: string;
    owner: string;
    changed: number;
    last_ok: string | Date | null;
  }>(sql`
    with people as (
      select distinct project_id, owner from memories
      where project_id is not null and scope in ('project', 'team')
    ),
    runs as (
      select project_id, owner,
        max(started_at) as last_any,
        max(started_at) filter (where error is null and finished_at is not null) as last_ok
      from dream_runs group by project_id, owner
    )
    select p.project_id, p.owner, r.last_ok,
      (select count(*)::int from memories m
        where m.project_id = p.project_id
          and (m.scope = 'team' or m.owner = p.owner)
          and not ('practice' = any(m.tags))
          and m.updated_at > coalesce(r.last_ok, '-infinity')) as changed
    from people p
    left join runs r on r.project_id = p.project_id and r.owner = p.owner
    where (r.last_any is null or r.last_any < now() - ${COOLDOWN}::interval)
      and (select count(*) from memories m
        where m.project_id = p.project_id
          and (m.scope = 'team' or m.owner = p.owner)
          and m.status in ('active', 'possibly_stale')
          and not ('practice' = any(m.tags))) >= ${MIN_DREAM_MEMORIES}
  `);
  // Below `every` changes, wait a day before regrouping.
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  return rows.flatMap((r): DueDream[] => {
    if (r.changed >= every)
      return [{ projectId: r.project_id, owner: r.owner, trigger: "count" }];
    const stale = !r.last_ok || new Date(r.last_ok).getTime() < dayAgo;
    return r.changed > 0 && stale
      ? [{ projectId: r.project_id, owner: r.owner, trigger: "daily" }]
      : [];
  });
}

/** Runs every due dream, one at a time. A failure is logged and doesn't stop the rest. */
export async function sweepDreams(
  db: Db,
  llm: LlmProvider,
  every = DREAM_EVERY,
): Promise<number> {
  let ran = 0;
  for (const d of await dueDreams(db, every)) {
    try {
      await runDream(db, llm, d.projectId, d.owner, d.trigger);
      ran++;
    } catch (err) {
      console.error(
        `dream ${d.trigger} for ${d.owner} in ${d.projectId} failed:`,
        err,
      );
    }
  }
  return ran;
}

/** Sweeps every SWEEP_MS. A sweep that is still running makes the next one skip. */
export function startDreamSchedule(
  db: Db,
  llm: LlmProvider,
  every = DREAM_EVERY,
): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await sweepDreams(db, llm, every);
    } catch (err) {
      console.error("dream sweep failed:", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** The person's last finished run in the project, for the sidebar. */
export async function lastDream(db: Db, projectId: string, owner: string) {
  const [row] = await db
    .select({
      finishedAt: dreamRuns.finishedAt,
      trigger: dreamRuns.trigger,
      error: dreamRuns.error,
    })
    .from(dreamRuns)
    .where(
      and(
        eq(dreamRuns.projectId, projectId),
        eq(dreamRuns.owner, owner),
        isNotNull(dreamRuns.finishedAt),
      ),
    )
    .orderBy(desc(dreamRuns.startedAt))
    .limit(1);
  return row
    ? {
        finishedAt: row.finishedAt?.toISOString() ?? null,
        trigger: row.trigger,
        error: row.error,
      }
    : null;
}
