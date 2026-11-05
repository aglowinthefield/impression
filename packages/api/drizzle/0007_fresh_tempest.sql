ALTER TABLE "proposals" ADD COLUMN "reviewed_at" timestamp with time zone;
--> statement-breakpoint
-- Every rejection so far was a person's decision.
UPDATE "proposals" SET "reviewed_at" = "created_at" WHERE "status" = 'rejected';