CREATE TABLE "user_settings" (
	"owner" text PRIMARY KEY NOT NULL,
	"extraction_floor" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
