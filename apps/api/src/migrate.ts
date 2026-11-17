import { runMigrations } from "@lumen/db/migrate";

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required");
await runMigrations(url);
console.log("Migrations applied");
