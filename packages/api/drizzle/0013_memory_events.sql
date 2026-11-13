CREATE TYPE "public"."memory_event_kind" AS ENUM('kept', 'rewritten', 'retired');--> statement-breakpoint
CREATE TABLE "memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"kind" "memory_event_kind" NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_events_memory_idx" ON "memory_events" USING btree ("memory_id");