import { asc, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { projects, proposals, sessions } from "./db/schema.js";
import { acceptProposal } from "./extract.js";
import type { Providers } from "./providers/index.js";
import { getExtractionFloor } from "./settings.js";

export interface BacklogSummary {
  /** New memories. */
  accepted: number;
  /** Already known: matched or merged into an active memory. */
  duplicates: number;
  belowFloor: number;
  /** Nothing left after scrubbing. */
  empty: number;
  /** Its session is gone, so there is no owner to accept it for. Left pending. */
  noOwner: number;
  /** Dry run only: at or above the floor, would go through acceptance. */
  toAccept: number;
}

/**
 * One-off: empties the old review queue. Every pending proposal at or above its
 * owner's extraction floor is accepted the way extraction now does it, so
 * near-copies of active memories are dropped. The ones below the floor are
 * marked rejected with no reviewedAt: no person rejected them, so extraction's
 * repeat check (which only looks at reviewed rejections) ignores them.
 */
export async function acceptBacklog(
  db: Db,
  providers: Providers,
  opts: { dryRun?: boolean } = {},
): Promise<BacklogSummary> {
  const rows = await db
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
    .orderBy(asc(proposals.createdAt));
  const summary: BacklogSummary = {
    accepted: 0,
    duplicates: 0,
    belowFloor: 0,
    empty: 0,
    noOwner: 0,
    toAccept: 0,
  };
  const floors = new Map<string, number>();
  for (const r of rows) {
    if (!r.owner) {
      summary.noOwner++;
      continue;
    }
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
    });
    if (outcome === "created") summary.accepted++;
    else if (outcome === "duplicate") summary.duplicates++;
    else if (outcome === "empty") summary.empty++;
  }
  return summary;
}
