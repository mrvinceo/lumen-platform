import { Pinecone } from "@pinecone-database/pinecone";
import { toProviderError } from "../errors.js";
import {
  type KbRef,
  scoreFromCosine,
  timed,
  type VectorItem,
  type VectorMatch,
  type VectorStore,
  VectorStoreError,
} from "../vectorStore.js";

export interface PineconeConfig {
  apiKey: string;
  indexName: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

const UPSERT_BATCH = 100;

/**
 * Pinecone (tenant's own index). Each knowledge base gets its own namespace, so deleting a KB is one call
 * and queries never mix KBs. Metadata carries documentId + audience for filtering and deletion.
 */
export function pineconeVectorStore(cfg: PineconeConfig): VectorStore {
  const pc = new Pinecone({ apiKey: cfg.apiKey, fetchApi: cfg.fetch, maxRetries: 2 });
  const ns = (kb: KbRef) => pc.index({ name: cfg.indexName }).namespace(kb.namespace);
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VectorStoreError) throw err;
      throw toProviderError(err, cfg.apiKey);
    }
  };

  async function describe() {
    const index = await pc.describeIndex(cfg.indexName);
    return { dimension: index.dimension, metric: index.metric, ready: index.status?.ready !== false };
  }

  async function checkIndex(dimension?: number) {
    const info = await describe();
    if (info.metric && info.metric !== "cosine") {
      throw new VectorStoreError(
        `Index "${cfg.indexName}" uses the ${info.metric} metric; Lumen needs cosine.`,
      );
    }
    if (dimension && info.dimension && info.dimension !== dimension) {
      throw new VectorStoreError(
        `Index "${cfg.indexName}" has ${info.dimension} dimensions but the embedding model produces ${dimension}.`,
        `Create a Pinecone index with dimension ${dimension} and metric cosine, or choose a matching embedding model.`,
      );
    }
    return info;
  }

  return {
    provider: "pinecone",

    ensureIndex: (kb) => wrap(async () => void (await checkIndex(kb.dimension))),

    upsert: (kb, items) =>
      wrap(async () => {
        const index = ns(kb);
        for (let i = 0; i < items.length; i += UPSERT_BATCH) {
          await index.upsert({
            records: items.slice(i, i + UPSERT_BATCH).map((it: VectorItem) => ({
              id: it.id,
              values: it.vector,
              metadata: { documentId: it.metadata.documentId, audience: it.metadata.audience },
            })),
          });
        }
      }),

    query: (kb, vector, opts) =>
      wrap(async () => {
        const res = await ns(kb).query({
          vector,
          topK: opts.topK,
          includeMetadata: true,
          filter: { audience: { $in: opts.audiences } },
        });
        return (res.matches ?? []).map(
          (m): VectorMatch => ({
            id: m.id,
            score: scoreFromCosine(m.score ?? 0),
            documentId: String(m.metadata?.documentId ?? ""),
          }),
        );
      }),

    deleteIds: (kb, ids) =>
      wrap(async () => {
        for (let i = 0; i < ids.length; i += 1000) await ns(kb).deleteMany({ ids: ids.slice(i, i + 1000) });
      }),

    deleteByDocument: (kb, documentId) =>
      wrap(() => ns(kb).deleteMany({ filter: { documentId: { $eq: documentId } } })),

    deleteNamespace: (kb) =>
      wrap(async () => {
        try {
          await ns(kb).deleteAll();
        } catch (err) {
          // Deleting a namespace that was never written to is fine.
          if ((err as { name?: string }).name !== "PineconeNotFoundError") throw err;
        }
      }),

    healthcheck: (expect) =>
      timed(async () => {
        try {
          const info = await checkIndex(expect?.dimension);
          return { message: `Connected to index "${cfg.indexName}" (${info.dimension} dimensions, cosine).` };
        } catch (err) {
          if (err instanceof VectorStoreError) throw err;
          throw toProviderError(err, cfg.apiKey);
        }
      }),
  };
}
