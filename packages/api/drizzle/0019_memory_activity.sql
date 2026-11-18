CREATE TYPE "public"."memory_event_actor" AS ENUM('extraction', 'check', 'person');--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'extracted';--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'added';--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'merged';--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'superseded';--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'edited';--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'flagged';--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'cleared';--> statement-breakpoint
ALTER TYPE "public"."memory_event_kind" ADD VALUE 'undone';--> statement-breakpoint
ALTER TABLE "memory_events" ALTER COLUMN "reason" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "actor" "memory_event_actor" DEFAULT 'check' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "principal" text;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "undoes" uuid;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "undone_by" uuid;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;