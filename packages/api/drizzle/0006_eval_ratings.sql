CREATE TABLE "eval_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"project_id" uuid,
	"agent_session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"prompt" text NOT NULL,
	"reply" text NOT NULL,
	"injected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ratings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_ratings" (
	"memory_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"rating" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_ratings_memory_id_owner_pk" PRIMARY KEY("memory_id","owner")
);
--> statement-breakpoint
ALTER TABLE "eval_turns" ADD CONSTRAINT "eval_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ratings" ADD CONSTRAINT "memory_ratings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_turns_turn_idx" ON "eval_turns" USING btree ("owner","agent_session_id","turn_index");--> statement-breakpoint
CREATE INDEX "eval_turns_project_idx" ON "eval_turns" USING btree ("project_id");