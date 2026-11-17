import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Role every tenant-scoped transaction switches to. It owns nothing and has no BYPASSRLS, so RLS always applies. */
export const APP_ROLE = "lumen_app";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DbHandle {
  db: Database;
  close(): Promise<void>;
}

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

/**
 * Runs `fn` in a transaction scoped to one tenant. Inside it:
 *  - `app.tenant_id` is set (transaction-local) and read by every RLS policy;
 *  - the role is switched to `lumen_app`, so RLS is enforced even when the pool's login user owns the tables.
 * All tenant data access in api/worker MUST go through this.
 */
export async function withTenant<T>(db: Database, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("withTenant: tenantId must be a UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return fn(tx);
  });
}

/**
 * Unscoped access for the few cross-tenant operations: auth (user → memberships), tenant signup,
 * resolving a widget public key to its tenant, and job scheduling. Keep call sites small and audited.
 */
export function withSystem<T>(db: Database, fn: (db: Database) => Promise<T>): Promise<T> {
  return fn(db);
}
