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
