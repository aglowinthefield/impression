ALTER TABLE "sessions" ADD COLUMN "source" text DEFAULT 'hook' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "piece_hash" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "extracting_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "extracted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_backfill_piece_idx" ON "sessions" USING btree ("owner","project_id","piece_hash") WHERE "sessions"."source" = 'backfill';