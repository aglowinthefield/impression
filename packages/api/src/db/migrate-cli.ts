import { DEFAULT_DATABASE_URL } from "./client.js";
import { runMigrations } from "./migrate.js";

await runMigrations(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
console.log("migrations applied");
