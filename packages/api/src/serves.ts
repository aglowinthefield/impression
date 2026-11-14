import type { Access } from "./access.js";
import type { Db } from "./db/client.js";
import { memoryServes } from "./db/schema.js";

export type ServeSource = (typeof memoryServes.$inferInsert)["source"];

/**
 * Records which memories a request handed to an agent. A failed write is logged
 * and swallowed, so the log can never fail the request that served them.
 */
export async function logServes(
  db: Db,
  memoryIds: string[],
  e: {
    source: ServeSource;
    principal: string;
    access: Access;
    projectId?: string | null;
    sessionKey?: string;
    agent?: string;
  },
) {
  if (memoryIds.length === 0) return;
  try {
    await db.insert(memoryServes).values(
      memoryIds.map((memoryId) => ({
        memoryId,
        projectId: e.projectId ?? null,
        userId: e.access.userId ?? null,
        principal: e.principal,
        source: e.source,
        sessionKey: e.sessionKey ?? null,
        agent: e.agent ?? null,
      })),
    );
  } catch (err) {
    console.error(
      "serve log failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
