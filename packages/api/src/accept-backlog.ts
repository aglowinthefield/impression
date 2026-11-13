import { asc, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { projects, proposals, sessions } from "./db/schema.js";
import { acceptProposal } from "./extract.js";
import type { Providers } from "./providers/index.js";
import { getExtractionFloor } from "./settings.js";

/** Consecutive failures after which the run stops: the providers are likely down. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface BacklogSummary {
  /** New memories. */
  created: number;
  /** New memories that replaced older ones. */
  superseded: number;
  /** Matched an active memory. */
  duplicates: number;
  /** Folded into an active memory. */
  merged: number;
  belowFloor: number;
  /** Nothing left after scrubbing. */
  empty: number;
  /** Its session is gone, so there is no owner to accept it for. Left pending. */
  noOwner: number;
  /** Dry run only: at or above the floor, would go through acceptance. */
  toAccept: number;
  /** Errored, including when dedup couldn't run. Put back to pending. */
  failed: number;
  /** Stopped after too many failures in a row. */
  aborted: boolean;
}

/**
 * One-off: empties the old review queue. Every pending proposal at or above its
 * owner's extraction floor is accepted the way extraction now does it, so
 * near-copies of active memories are dropped. The ones below the floor are
 * marked rejected with no reviewedAt: no person rejected them, so extraction's
 * repeat check (which only looks at reviewed rejections) ignores them.
 *
 * A proposal is never added unchecked: if the embedding or the dedup LLM call
 * fails, it goes back to pending and counts as failed. The run stops after
 * MAX_CONSECUTIVE_FAILURES in a row. `limit` takes only the oldest N pending.
 */
export async function acceptBacklog(
  db: Db,
  providers: Providers,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<BacklogSummary> {
  const query = db
    .select({
      id: proposals.id,
      confidence: proposals.confidence,
      sessionId: proposals.sessionId,
      owner: sessions.owner,
      projectKey: projects.key,
    })
    .from(proposals)
    .innerJoin(projects, eq(projects.id, proposals.projectId))
    .leftJoin(sessions, eq(sessions.id, proposals.sessionId))
    .where(eq(proposals.status, "pending"))
    .orderBy(asc(proposals.createdAt), asc(proposals.id));
  const rows = await (opts.limit !== undefined
    ? query.limit(opts.limit)
    : query);
  const summary: BacklogSummary = {
    created: 0,
    superseded: 0,
    duplicates: 0,
    merged: 0,
    belowFloor: 0,
    empty: 0,
    noOwner: 0,
    toAccept: 0,
    failed: 0,
    aborted: false,
  };
  let failedInARow = 0;
  const floors = new Map<string, number>();
  for (const r of rows) {
    if (!r.owner) {
      summary.noOwner++;
      continue;
    }
    try {
      let floor = floors.get(r.owner);
      if (floor === undefined) {
        floor = await getExtractionFloor(db, r.owner);
        floors.set(r.owner, floor);
      }
      if (r.confidence < floor) {
        summary.belowFloor++;
        if (!opts.dryRun)
          await db
            .update(proposals)
            .set({ status: "rejected" })
            .where(eq(proposals.id, r.id));
        continue;
      }
      if (opts.dryRun) {
        summary.toAccept++;
        continue;
      }
      const outcome = await acceptProposal(db, providers, r.id, r.owner, {
        projectKey: r.projectKey,
        sessionId: r.sessionId,
        requireDedup: true,
      });
      failedInARow = 0;
      if (outcome === "created") summary.created++;
      else if (outcome === "superseded") summary.superseded++;
      else if (outcome === "duplicate") summary.duplicates++;
      else if (outcome === "merged") summary.merged++;
      else if (outcome === "empty") summary.empty++;
    } catch (err) {
      console.error(
        `proposal ${r.id} failed:`,
        err instanceof Error ? err.message : err,
      );
      summary.failed++;
      if (!opts.dryRun)
        await db
          .update(proposals)
          .set({ status: "pending", memoryId: null })
          .where(eq(proposals.id, r.id))
          .catch(() => {});
      if (++failedInARow >= MAX_CONSECUTIVE_FAILURES) {
        summary.aborted = true;
        break;
      }
    }
  }
  return summary;
}
