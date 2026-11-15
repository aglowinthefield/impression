ALTER TABLE "api_tokens" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_client" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_ip" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_rejected_client" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "last_rejected_ip" text;