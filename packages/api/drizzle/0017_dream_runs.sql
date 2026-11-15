CREATE TABLE "dream_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"trigger" text NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"memories" integer,
	"concepts" integer,
	"created" integer,
	"kept" integer,
	"removed" integer,
	"uncategorized" integer,
	"cost_micros" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "dream_runs" ADD CONSTRAINT "dream_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dream_runs_project_owner_idx" ON "dream_runs" USING btree ("project_id","owner","started_at");