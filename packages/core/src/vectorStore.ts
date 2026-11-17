export type Audience = "public" | "staff";

export interface KbRef {
  tenantId: string;
  kbId: string;
  /** Pinecone namespace / Firestore collection suffix. */
  namespace: string;
  dimension: number;
}

export interface VectorItem {
  /** Chunk id. Deterministic so re-ingestion is idempotent. */
  id: string;
  vector: number[];
  metadata: { documentId: string; audience: Audience };
}

export interface VectorMatch {
  id: string;
  /** Similarity in [0, 1]; higher is better. Every adapter maps cosine similarity s to (s + 1) / 2. */
  score: number;
  documentId: string;
}

export interface QueryOptions {
  topK: number;
  audiences: Audience[];
}

export interface HealthResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  /** Extra setup the tenant must do, e.g. the command that creates a Firestore vector index. */
  action?: string;
}

export interface VectorStore {
  readonly provider: string;
  /** Prepares storage for a knowledge base; for BYO stores, checks the index matches the KB's dimension. */
  ensureIndex(kb: KbRef): Promise<void>;
  upsert(kb: KbRef, items: VectorItem[]): Promise<void>;
  query(kb: KbRef, vector: number[], opts: QueryOptions): Promise<VectorMatch[]>;
  deleteIds(kb: KbRef, ids: string[]): Promise<void>;
  deleteByDocument(kb: KbRef, documentId: string): Promise<void>;
  /** Removes everything stored for a knowledge base. */
  deleteNamespace(kb: KbRef): Promise<void>;
  healthcheck(expect?: { dimension?: number }): Promise<HealthResult>;
}

/** Cosine similarity in [-1, 1] → score in [0, 1]. */
export const scoreFromCosine = (similarity: number): number => Math.min(1, Math.max(0, (similarity + 1) / 2));
/** Cosine distance in [0, 2] → score in [0, 1]. */
export const scoreFromCosineDistance = (distance: number): number => scoreFromCosine(1 - distance);

export async function timed(
  check: () => Promise<{ message: string; action?: string }>,
): Promise<HealthResult> {
  const started = performance.now();
  try {
    const r = await check();
    return { ok: true, latencyMs: Math.round(performance.now() - started), ...r };
  } catch (err) {
    const e = err as { message?: string; action?: string };
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      message: e?.message ?? String(err),
      action: e?.action,
    };
  }
}

export class VectorStoreError extends Error {
  constructor(
    message: string,
    readonly action?: string,
  ) {
    super(message);
    this.name = "VectorStoreError";
  }
}
