ALTER TABLE "memories" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "scope" "memory_scope" DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;