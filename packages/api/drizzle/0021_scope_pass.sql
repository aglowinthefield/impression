ALTER TYPE "public"."memory_event_actor" ADD VALUE 'pass';--> statement-breakpoint
-- Added empty first, so every memory stored before this release stays null and the
-- one-time pass for practices and to-dos picks it up. The default set after it marks
-- memories written from now on as already following those rules.
ALTER TABLE "memories" ADD COLUMN "scope_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "scope_checked_at" SET DEFAULT now();
