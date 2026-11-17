import {
  type Audience,
  createEmbeddingModel,
  type EmbeddingModel,
  firestoreVectorStore,
  isProviderId,
  type KbRef,
  ProviderError,
  pineconeVectorStore,
  type VectorStore,
} from "@lumen/core";
import type { KeyProvider } from "@lumen/crypto";
import { and, type Database, eq, schema, sql, type Tx } from "@lumen/db";
import type { ObjectStore } from "./objectStore.js";
import { readSecret } from "./secrets.js";
import { pgvectorManagedStore } from "./vectorstores/pgvectorManaged.js";

/** Everything server code needs to act for a tenant. */
export interface RuntimeDeps {
  db: Database;
  keys: KeyProvider;
  objects: ObjectStore;
  /** Injected in tests to stub provider HTTP calls. */
  fetch?: typeof fetch;
}

export type VectorStoreRow = typeof schema.vectorStores.$inferSelect;
export type KnowledgeBaseRow = typeof schema.knowledgeBases.$inferSelect;

export interface PineconeStoreConfig {
  indexName: string;
}
export interface FirestoreStoreConfig {
  projectId?: string;
  databaseId?: string;
}

export const MANAGED_STORE_LABEL = "Lumen managed (Postgres)";

/** Returns the tenant's platform-managed store, creating it on first use. */
export async function ensureManagedStore(tx: Tx, tenantId: string): Promise<VectorStoreRow> {
  await tx.execute(sql`
    insert into vector_stores (tenant_id, provider, label)
    values (${tenantId}, 'pgvector_managed', ${MANAGED_STORE_LABEL})
    on conflict (tenant_id) where provider = 'pgvector_managed' do nothing`);
  const [row] = await tx
    .select()
    .from(schema.vectorStores)
    .where(
      and(eq(schema.vectorStores.tenantId, tenantId), eq(schema.vectorStores.provider, "pgvector_managed")),
    );
  if (!row) throw new Error("managed store missing");
  return row;
}

/** Builds the adapter for a stored vector-store configuration, decrypting its credential. */
export async function vectorStoreFromRow(
  tx: Tx,
  deps: RuntimeDeps,
  row: VectorStoreRow,
): Promise<VectorStore> {
  const secret = row.secretId ? await readSecret(tx, deps.keys, row.tenantId, row.secretId) : undefined;
  switch (row.provider) {
    case "pgvector_managed":
      return pgvectorManagedStore(deps.db);
    case "pinecone": {
      const cfg = row.config as unknown as PineconeStoreConfig;
      if (!secret) throw new ProviderError("auth", "This Pinecone store has no API key.");
      return pineconeVectorStore({ apiKey: secret, indexName: cfg.indexName, fetch: deps.fetch });
    }
    case "firestore": {
      const cfg = row.config as FirestoreStoreConfig;
      if (!secret) throw new ProviderError("auth", "This Firestore store has no service account key.");
      return firestoreVectorStore({
        serviceAccountJson: secret,
        projectId: cfg.projectId,
        databaseId: cfg.databaseId,
      });
    }
    default:
      throw new ProviderError("bad_request", `Unsupported vector store: ${row.provider}`);
  }
}

export async function embeddingModelFromConfig(
  tx: Tx,
  deps: RuntimeDeps,
  tenantId: string,
  configId: string,
): Promise<EmbeddingModel> {
  const [cfg] = await tx
    .select()
    .from(schema.providerConfigs)
    .where(and(eq(schema.providerConfigs.id, configId), eq(schema.providerConfigs.tenantId, tenantId)));
  if (cfg?.type !== "embedding")
    throw new ProviderError("not_found", "Embedding model configuration not found.");
  if (!isProviderId(cfg.provider)) throw new ProviderError("bad_request", `Unknown provider ${cfg.provider}`);
  const apiKey = cfg.secretId ? await readSecret(tx, deps.keys, tenantId, cfg.secretId) : undefined;
  return createEmbeddingModel({
    provider: cfg.provider,
    model: cfg.model,
    apiKey,
    baseUrl: cfg.baseUrl ?? undefined,
    dimension: (cfg.options as { dimension?: number }).dimension,
    fetch: deps.fetch,
  });
}

export const kbRef = (kb: KnowledgeBaseRow): KbRef => ({
  tenantId: kb.tenantId,
  kbId: kb.id,
  namespace: kb.namespace,
  dimension: kb.dimension,
});

export interface LoadedKnowledgeBase {
  kb: KnowledgeBaseRow;
  ref: KbRef;
  store: VectorStore;
  embedder: EmbeddingModel;
}

/** Loads a knowledge base with its ready-to-use vector store and embedding model. */
export async function loadKnowledgeBase(
  tx: Tx,
  deps: RuntimeDeps,
  tenantId: string,
  kbId: string,
): Promise<LoadedKnowledgeBase> {
  const [kb] = await tx
    .select()
    .from(schema.knowledgeBases)
    .where(and(eq(schema.knowledgeBases.id, kbId), eq(schema.knowledgeBases.tenantId, tenantId)));
  if (!kb) throw new ProviderError("not_found", "Knowledge base not found.");
  const [storeRow] = await tx
    .select()
    .from(schema.vectorStores)
    .where(eq(schema.vectorStores.id, kb.vectorStoreId));
  if (!storeRow) throw new ProviderError("not_found", "Vector store not found.");
  return {
    kb,
    ref: kbRef(kb),
    store: await vectorStoreFromRow(tx, deps, storeRow),
    embedder: await embeddingModelFromConfig(tx, deps, tenantId, kb.embeddingConfigId),
  };
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  score: number;
  text: string;
  headings: string[];
  page?: number;
  audience: Audience;
}

/**
 * Embeds a query and returns the best-matching chunks with their text. Vector stores return ids and scores;
 * the canonical text, headings and document titles come from Postgres.
 */
export async function searchKnowledgeBase(
  loaded: LoadedKnowledgeBase,
  query: string,
  opts: { topK?: number; audiences: Audience[] },
  hydrate: (
    ids: string[],
  ) => Promise<
    { id: string; text: string; metadata: unknown; audience: Audience; documentId: string; title: string }[]
  >,
): Promise<{ hits: SearchHit[]; tokens: number }> {
  const { vectors, tokens } = await loaded.embedder.embed([query], "query");
  const vector = vectors[0];
  if (!vector) return { hits: [], tokens };
  const matches = await loaded.store.query(loaded.ref, vector, {
    topK: opts.topK ?? 8,
    audiences: opts.audiences,
  });
  if (matches.length === 0) return { hits: [], tokens };
  const rows = new Map((await hydrate(matches.map((m) => m.id))).map((r) => [r.id, r]));
  const hits: SearchHit[] = [];
  for (const m of matches) {
    const r = rows.get(m.id);
    // A vector without a chunk row (e.g. deleted between query and hydrate) is skipped; so is any chunk whose
    // audience is not allowed, as a second check after the store's own filter.
    if (!r || !opts.audiences.includes(r.audience)) continue;
    const meta = r.metadata as { headings?: string[]; page?: number };
    hits.push({
      chunkId: r.id,
      documentId: r.documentId,
      documentTitle: r.title,
      score: m.score,
      text: r.text,
      headings: meta.headings ?? [],
      page: meta.page,
      audience: r.audience,
    });
  }
  return { hits, tokens };
}
