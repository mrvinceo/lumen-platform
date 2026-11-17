import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

/** Overridable so bundled deployments (Docker) can ship migrations next to the compiled entrypoint. */
export const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
