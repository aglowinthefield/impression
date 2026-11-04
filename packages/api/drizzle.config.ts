import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  casing: "snake_case",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://impression:impression@localhost:54329/impression",
  },
});
