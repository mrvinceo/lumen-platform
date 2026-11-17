export type Audience = "public" | "staff";

export interface KbRef {
  tenantId: string;
  kbId: string;
  namespace: string;
  dimension: number;
}

export interface VectorItem {
  /** Chunk id. Deterministic so re-ingestion is idempotent. */
  id: string;
  vector: number[];
  metadata: { documentId: string; audience: Audience; [key: string]: unknown };
}

export interface VectorMatch {
  id: string;
  /** Similarity in [0, 1]; higher is better. Adapters normalise provider-specific distances. */
  score: number;
  metadata: Record<string, unknown>;
}

export interface QueryOptions {
  topK: number;
  audiences: Audience[];
}

export interface HealthResult {
  ok: boolean;
  message?: string;
  latencyMs?: number;
}

export interface VectorStore {
  readonly provider: string;
  ensureIndex(kb: KbRef): Promise<void>;
  upsert(kb: KbRef, items: VectorItem[]): Promise<void>;
  query(kb: KbRef, vector: number[], opts: QueryOptions): Promise<VectorMatch[]>;
  deleteByDocument(kb: KbRef, documentId: string): Promise<void>;
  healthcheck(): Promise<HealthResult>;
}
