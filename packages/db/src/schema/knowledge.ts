import { type SQL, sql } from "drizzle-orm";
import {
  customType,
  foreignKey,
  halfvec,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { tenantIdColumn, tenantIsolation, tenantScopedId, timestamps } from "./_helpers.js";
import { providerConfigs, secrets, vectorStores } from "./providers.js";
import { tenants } from "./tenancy.js";

export const audienceEnum = pgEnum("audience", ["public", "staff"]);
export const kbStatusEnum = pgEnum("kb_status", ["active", "reindexing", "disabled"]);

/** Supported dimensions for the platform-managed pgvector store. Each maps to its own table + HNSW index. */
export const MANAGED_DIMENSIONS = [768, 1024, 1536, 3072] as const;
export type ManagedDimension = (typeof MANAGED_DIMENSIONS)[number];

/**
 * A knowledge base pins one embedding model + one vector store. Changing the embedding model means
 * a new KB version and a full re-embed (dimensions and vector spaces are not interchangeable).
 */
export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    embeddingConfigId: uuid("embedding_config_id").notNull(),
    vectorStoreId: uuid("vector_store_id").notNull(),
    dimension: integer("dimension").notNull(),
    /** Pinecone namespace / Firestore collection / logical partition inside the vector store. */
    namespace: text("namespace").notNull(),
    version: integer("version").notNull().default(1),
    status: kbStatusEnum("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    tenantScopedId("knowledge_bases", t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.embeddingConfigId],
      foreignColumns: [providerConfigs.tenantId, providerConfigs.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.vectorStoreId],
      foreignColumns: [vectorStores.tenantId, vectorStores.id],
    }),
    tenantIsolation(t.tenantId),
  ],
);

export const sourceTypeEnum = pgEnum("source_type", ["upload", "gdrive", "onedrive"]);
export const syncStatusEnum = pgEnum("sync_status", ["idle", "queued", "syncing", "error"]);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id").notNull(),
    type: sourceTypeEnum("type").notNull(),
    name: text("name").notNull(),
    /** OAuth refresh token / service account for cloud connectors. */
    secretId: uuid("secret_id"),
    /** Connector settings: folder ids, drive id, include/exclude globs... */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    audience: audienceEnum("audience").notNull().default("public"),
    /** Drive Changes API page token / Graph delta link. */
    syncCursor: text("sync_cursor"),
    /** Cron expression; null = manual only. */
    schedule: text("schedule"),
    status: syncStatusEnum("status").notNull().default("idle"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    tenantScopedId("sources", t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.kbId],
      foreignColumns: [knowledgeBases.tenantId, knowledgeBases.id],
    }).onDelete("cascade"),
    foreignKey({ columns: [t.tenantId, t.secretId], foreignColumns: [secrets.tenantId, secrets.id] }),
    tenantIsolation(t.tenantId),
  ],
);

export const documentStatusEnum = pgEnum("document_status", ["pending", "indexed", "excluded", "error"]);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    /** Drive file id / Graph item id / object-storage key. */
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    mimeType: text("mime_type"),
    contentHash: text("content_hash"),
    version: integer("version").notNull().default(1),
    audience: audienceEnum("audience").notNull().default("public"),
    status: documentStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    tenantScopedId("documents", t.tenantId, t.id),
    unique("documents_source_external_key").on(t.sourceId, t.externalId),
    foreignKey({
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [sources.tenantId, sources.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.kbId],
      foreignColumns: [knowledgeBases.tenantId, knowledgeBases.id],
    }).onDelete("cascade"),
    tenantIsolation(t.tenantId),
  ],
);

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Canonical chunk text, independent of which vector store holds the embeddings. Lets us render citations,
 * re-embed with a new model, or migrate vector stores without re-fetching and re-parsing source files.
 */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    kbId: uuid("kb_id").notNull(),
    documentId: uuid("document_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count").notNull(),
    contentHash: text("content_hash").notNull(),
    audience: audienceEnum("audience").notNull().default("public"),
    /** Heading path, page number, etc. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Keyword index for hybrid (vector + full-text) retrieval. */
    tsv: tsvector("tsv").generatedAlwaysAs((): SQL => sql`to_tsvector('simple', ${chunks.text})`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantScopedId("chunks", t.tenantId, t.id),
    unique("chunks_document_ordinal_key").on(t.documentId, t.ordinal),
    foreignKey({
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }).onDelete("cascade"),
    index("chunks_kb_idx").on(t.tenantId, t.kbId),
    index("chunks_tsv_idx").using("gin", t.tsv),
    tenantIsolation(t.tenantId),
  ],
);

/** Embeddings for the platform-managed pgvector store, one table per dimension (HNSW needs a fixed size). */
function embeddingTable<N extends ManagedDimension>(dimension: N) {
  const name = `embeddings_${dimension}`;
  // pgvector HNSW indexes support up to 2000 dims for `vector`; larger models use `halfvec` (up to 4000).
  const useHalf = dimension > 2000;
  return pgTable(
    name,
    {
      chunkId: uuid("chunk_id").primaryKey(),
      tenantId: tenantIdColumn(),
      kbId: uuid("kb_id").notNull(),
      audience: audienceEnum("audience").notNull().default("public"),
      embedding: useHalf
        ? halfvec("embedding", { dimensions: dimension }).notNull()
        : vector("embedding", { dimensions: dimension }).notNull(),
    },
    (t) => [
      foreignKey({ columns: [t.tenantId, t.chunkId], foreignColumns: [chunks.tenantId, chunks.id] }).onDelete(
        "cascade",
      ),
      index(`${name}_kb_idx`).on(t.tenantId, t.kbId),
      index(`${name}_hnsw_idx`).using(
        "hnsw",
        t.embedding.op(useHalf ? "halfvec_cosine_ops" : "vector_cosine_ops"),
      ),
      tenantIsolation(t.tenantId),
    ],
  );
}

export const embeddings768 = embeddingTable(768);
export const embeddings1024 = embeddingTable(1024);
export const embeddings1536 = embeddingTable(1536);
export const embeddings3072 = embeddingTable(3072);

export const embeddingTables = {
  768: embeddings768,
  1024: embeddings1024,
  1536: embeddings1536,
  3072: embeddings3072,
} as const;

export const jobKindEnum = pgEnum("job_kind", ["full_sync", "incremental_sync", "reindex", "delete"]);
export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);

export const ingestionJobs = pgTable(
  "ingestion_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn().references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull(),
    kind: jobKindEnum("kind").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    /** 0-100 */
    progress: integer("progress_pct").notNull().default(0),
    stats: jsonb("stats")
      .$type<{ files?: number; chunks?: number; tokens?: number; skipped?: number; failed?: number }>()
      .notNull()
      .default({}),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [sources.tenantId, sources.id],
    }).onDelete("cascade"),
    index("ingestion_jobs_source_created_idx").on(t.sourceId, t.createdAt),
    tenantIsolation(t.tenantId),
  ],
);
