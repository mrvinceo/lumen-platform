import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { currentTenant, tenantIsolation, timestamps } from "./_helpers.js";

export const planEnum = pgEnum("plan", ["free", "pro", "enterprise", "selfhost"]);
export const memberRoleEnum = pgEnum("member_role", ["owner", "admin", "editor", "viewer"]);

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    plan: planEnum("plan").notNull().default("free"),
    ...timestamps,
  },
  () => [
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      using: sql`id = ${currentTenant}`,
      withCheck: sql`id = ${currentTenant}`,
    }),
  ],
);

/**
 * Global identity table (not tenant scoped). Shaped to be used as Better Auth's `user` model in Phase 1.
 * Only the auth layer reads it, through the system (non-RLS) connection.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  ...timestamps,
});

export const members = pgTable(
  "members",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum("role").notNull().default("viewer"),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("members_user_idx").on(t.userId),
    tenantIsolation(t.tenantId),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    target: text("target"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt), tenantIsolation(t.tenantId)],
);
