CREATE TABLE "concept_links" (
	"a_id" uuid NOT NULL,
	"b_id" uuid NOT NULL,
	CONSTRAINT "concept_links_a_id_b_id_pk" PRIMARY KEY("a_id","b_id")
);
--> statement-breakpoint
CREATE TABLE "concept_memories" (
	"concept_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	CONSTRAINT "concept_memories_concept_id_memory_id_pk" PRIMARY KEY("concept_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "concept_links" ADD CONSTRAINT "concept_links_a_id_concepts_id_fk" FOREIGN KEY ("a_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_links" ADD CONSTRAINT "concept_links_b_id_concepts_id_fk" FOREIGN KEY ("b_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_memories" ADD CONSTRAINT "concept_memories_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_memories" ADD CONSTRAINT "concept_memories_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_parent_id_concepts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."concepts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concept_memories_memory_idx" ON "concept_memories" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "concepts_project_owner_idx" ON "concepts" USING btree ("project_id","owner");