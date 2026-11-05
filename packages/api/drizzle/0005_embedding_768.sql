-- 1536 -> 768 dimensions, so a small local model (nomic-embed-text) fits. Existing
-- vectors can't be cast, so clear them: run `pnpm --filter @impression/api db:reembed`.
-- Until then, search falls back to keyword results for memories without a vector.
DROP INDEX IF EXISTS "memories_embedding_idx";--> statement-breakpoint
UPDATE "memories" SET "embedding" = NULL, "embedding_model" = NULL, "embedding_dim" = NULL;--> statement-breakpoint
UPDATE "proposals" SET "embedding" = NULL;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "embedding" SET DATA TYPE vector(768);--> statement-breakpoint
ALTER TABLE "proposals" ALTER COLUMN "embedding" SET DATA TYPE vector(768);--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);
