import type { Queryer } from "./db/client.js";
import { memoryEvents } from "./db/schema.js";

export type EventKind = (typeof memoryEvents.$inferInsert)["kind"];
export type EventActor = "extraction" | "check" | "person" | "pass";

/**
 * The one-time scope pass (run on 2026-11-28, then removed) has no value in the
 * actor column. Its events are stored as extraction's with this in `detail.by`,
 * and Activity reads them back as "pass", so they stay visible and undoable.
 */
export const PASS_BY = "scope-pass";

/** Who made a change, as createMemory and the routes pass it to `logEvent`. */
export interface EventSource {
  actor: EventActor;
  principal: string;
  sessionId?: string | null;
  reason?: string;
}

/**
 * Records one change to a memory. Call it on the same transaction as the change,
 * so a change never exists without its entry.
 */
export async function logEvent(
  db: Queryer,
  memoryId: string,
  kind: EventKind,
  source: EventSource,
  detail: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(memoryEvents)
    .values({
      memoryId,
      kind,
      actor: source.actor === "pass" ? "extraction" : source.actor,
      principal: source.principal,
      sessionId: source.sessionId ?? null,
      reason: source.reason ?? "",
      detail: source.actor === "pass" ? { ...detail, by: PASS_BY } : detail,
    })
    .returning({ id: memoryEvents.id });
  return (row as { id: string }).id;
}
