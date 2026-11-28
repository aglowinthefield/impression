import { createHash } from "node:crypto";

/**
 * Identifies a backfill piece across runs: sha256 of its text, trimmed. The API
 * stores it at upload and the CLI sends it in a backfill plan, so both must
 * hash the same way; the API trims every transcript it receives.
 */
export function pieceHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}
