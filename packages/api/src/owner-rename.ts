import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";

/**
 * Moves everything one owner name wrote onto another. A person signing in with GitHub
 * is a new owner (their login), so this carries over what an earlier `token:create`
 * name wrote. It also repairs data after a GitHub login rename.
 */
export async function renameOwner(db: Db, from: string, to: string) {
  return db.transaction(async (tx) => {
    const n = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).count;
    // A rating the new owner already gave the same memory wins.
    await tx.execute(
      sql`DELETE FROM memory_ratings r WHERE r.owner = ${from} AND EXISTS (SELECT 1 FROM memory_ratings x WHERE x.memory_id = r.memory_id AND x.owner = ${to})`,
    );
    // The old owner's concepts and dream runs go. Moved memories count as
    // changed, so the schedule regroups them into the new owner's concepts.
    const concepts = await n(sql`DELETE FROM concepts WHERE owner = ${from}`);
    await tx.execute(sql`DELETE FROM dream_runs WHERE owner = ${from}`);
    // A backfill piece both names stored is kept once, as its unique index
    // needs: the new owner's row, unless only the old owner's was extracted.
    // What pointed at the dropped row moves to the kept one.
    const pairs = await tx.execute<{
      fid: string;
      tid: string;
      keepFrom: boolean;
    }>(sql`
      SELECT f.id AS fid, t.id AS tid,
        (f.extracted_at IS NOT NULL AND t.extracted_at IS NULL) AS "keepFrom"
      FROM sessions f JOIN sessions t
        ON t.owner = ${to} AND t.source = 'backfill'
        AND t.project_id = f.project_id AND t.piece_hash = f.piece_hash
      WHERE f.owner = ${from} AND f.source = 'backfill'`);
    for (const p of pairs) {
      const [keep, drop] = p.keepFrom ? [p.fid, p.tid] : [p.tid, p.fid];
      for (const table of ["memories", "proposals", "memory_events"])
        await tx.execute(
          sql`UPDATE ${sql.identifier(table)} SET session_id = ${keep} WHERE session_id = ${drop}`,
        );
      await tx.execute(sql`DELETE FROM sessions WHERE id = ${drop}`);
    }
    return {
      memories: await n(
        sql`UPDATE memories SET owner = ${to}, updated_at = now() WHERE owner = ${from}`,
      ),
      authored: await n(
        sql`UPDATE memories SET author = ${to} WHERE author = ${from}`,
      ),
      sessions: await n(
        sql`UPDATE sessions SET owner = ${to} WHERE owner = ${from}`,
      ),
      // Backfill spend follows the person, so their budget doesn't start over.
      // A GitHub user's spend is summed by user id, so rows without one take
      // the new name's user, if it is one.
      usageEvents: await n(
        sql`UPDATE usage_events SET principal = ${to}, user_id = coalesce(user_id, (SELECT id FROM users WHERE login = ${to} ORDER BY last_login_at DESC LIMIT 1)) WHERE principal = ${from}`,
      ),
      evalTurns: await n(
        sql`UPDATE eval_turns SET owner = ${to} WHERE owner = ${from}`,
      ),
      ratings: await n(
        sql`UPDATE memory_ratings SET owner = ${to} WHERE owner = ${from}`,
      ),
      concepts,
    };
  });
}
