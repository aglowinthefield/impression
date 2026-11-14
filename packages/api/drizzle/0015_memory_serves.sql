CREATE TYPE "public"."serve_source" AS ENUM('core', 'prompt', 'search');--> statement-breakpoint
CREATE TABLE "memory_serves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"principal" text NOT NULL,
	"source" "serve_source" NOT NULL,
	"session_key" text,
	"agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "session_key" text;--> statement-breakpoint
ALTER TABLE "memory_serves" ADD CONSTRAINT "memory_serves_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_serves" ADD CONSTRAINT "memory_serves_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_serves" ADD CONSTRAINT "memory_serves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_serves_memory_idx" ON "memory_serves" USING btree ("memory_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_serves_session_idx" ON "memory_serves" USING btree ("session_key");--> statement-breakpoint
CREATE INDEX "sessions_session_key_idx" ON "sessions" USING btree ("session_key");