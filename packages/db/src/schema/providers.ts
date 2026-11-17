import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantIdColumn, tenantIsolation, tenantScopedId, timestamps } from "./_helpers.js";
import { tenants } from "./tenancy.js";

export const secretKindEnum = pgEnum("secret_kind", [
  "llm_api_key",
  "embedding_api_key",
  "rerank_api_key",
  "vector_store_credential",
  "oauth_token",
  "service_account",
  "sso_signing_secret",
]);

/** Envelope-encrypted tenant secrets (see @lumen/crypto). Plaintext never leaves api/worker. */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    kind: secretKindEnum("kind").notNull(),
    label: text("label").notNull(),
    ciphertext: text("ciphertext").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    keyId: text("key_id").notNull(),
    last4: text("last4").notNull().default(""),
    ...timestamps,
  },
  (t) => [tenantScopedId("secrets", t.tenantId, t.id), tenantIsolation(t.tenantId)],
);

export const providerTypeEnum = pgEnum("provider_type", ["llm", "embedding", "rerank"]);

/** A configured model: provider + model id + credential, e.g. OpenAI gpt-5-mini or Voyage voyage-3. */
export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    type: providerTypeEnum("type").notNull(),
    /** openai | anthropic | google | openai_compatible | voyage | cohere */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    label: text("label").notNull(),
    secretId: uuid("secret_id"),
    baseUrl: text("base_url"),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    tenantScopedId("provider_configs", t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.secretId], foreignColumns: [secrets.tenantId, secrets.id] }),
    index("provider_configs_tenant_type_idx").on(t.tenantId, t.type),
    tenantIsolation(t.tenantId),
  ],
);

export const vectorStoreProviderEnum = pgEnum("vector_store_provider", [
  "pgvector_managed",
  "pgvector",
  "pinecone",
  "firestore",
]);

export const vectorStores = pgTable(
  "vector_stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    provider: vectorStoreProviderEnum("provider").notNull(),
    label: text("label").notNull(),
    secretId: uuid("secret_id"),
    /** Non-secret settings: Pinecone index name, Firestore project id, etc. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Result of the last health check, shown in the console. */
    lastCheckOk: boolean("last_check_ok"),
    lastCheckMessage: text("last_check_message"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    tenantScopedId("vector_stores", t.tenantId, t.id),
    // Exactly one platform-managed store per tenant, created on first use.
    uniqueIndex("vector_stores_one_managed_per_tenant")
      .on(t.tenantId)
      .where(sql`provider = 'pgvector_managed'`),
    foreignKey({ columns: [t.tenantId, t.secretId], foreignColumns: [secrets.tenantId, secrets.id] }),
    tenantIsolation(t.tenantId),
  ],
);
