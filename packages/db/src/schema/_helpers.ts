import { sql } from "drizzle-orm";
import { pgPolicy, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * Fail-closed tenant predicate. When `app.tenant_id` is unset (or empty) the cast yields NULL and
 * no rows match. The value is set per-transaction by `withTenant()`.
 */
export const currentTenant = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;

export const tenantIdColumn = () => uuid("tenant_id").notNull();

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** RLS policy restricting every operation to the current tenant's rows. */
export const tenantIsolation = (tenantCol: { name: string }) =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    using: sql`${sql.identifier(tenantCol.name)} = ${currentTenant}`,
    withCheck: sql`${sql.identifier(tenantCol.name)} = ${currentTenant}`,
  });

/**
 * Unique (tenant_id, id) so children can use composite foreign keys. Foreign-key checks bypass RLS,
 * so composite FKs are what stop a row in tenant A referencing a row owned by tenant B.
 */
export const tenantScopedId = (name: string, tenantId: { name: string }, id: { name: string }) =>
  // biome-ignore lint/suspicious/noExplicitAny: drizzle column types are structural here
  unique(`${name}_tenant_id_id_key`).on(tenantId as any, id as any);
