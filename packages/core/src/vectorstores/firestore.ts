import { FieldValue, Firestore } from "@google-cloud/firestore";
import { toProviderError } from "../errors.js";
import {
  type KbRef,
  scoreFromCosineDistance,
  timed,
  type VectorMatch,
  type VectorStore,
  VectorStoreError,
} from "../vectorStore.js";

export const FIRESTORE_MAX_DIMENSION = 2048;

export interface FirestoreConfig {
  /** Service-account key JSON (as uploaded by the tenant). */
  serviceAccountJson: string;
  projectId?: string;
  databaseId?: string;
  /** Injected in tests. */
  client?: Firestore;
}

interface ServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

export function parseServiceAccount(json: string): Required<ServiceAccount> {
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(json) as ServiceAccount;
  } catch {
    throw new VectorStoreError("The service account key is not valid JSON.");
  }
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new VectorStoreError(
      "The service account key must include project_id, client_email and private_key.",
    );
  }
  return { project_id: sa.project_id, client_email: sa.client_email, private_key: sa.private_key };
}

export const firestoreCollection = (kb: Pick<KbRef, "namespace">) => `lumen_${kb.namespace}`;

/** The command a tenant runs once per knowledge base to create the vector index Firestore requires. */
export function firestoreIndexCommand(
  projectId: string,
  collection: string,
  dimension: number,
  databaseId = "(default)",
) {
  return [
    "gcloud firestore indexes composite create",
    `--project=${projectId}`,
    databaseId !== "(default)" ? `--database=${databaseId}` : "",
    `--collection-group=${collection}`,
    "--query-scope=COLLECTION",
    "--field-config=order=ASCENDING,field-path=audience",
    `--field-config=field-path=embedding,vector-config='{"dimension":"${dimension}","flat":"{}"}'`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Firestore (tenant's own project), following the pattern Lumen already uses: one collection per knowledge
 * base, documents { embedding: vector, documentId, audience }, and findNearest with an audience pre-filter.
 */
export function firestoreVectorStore(cfg: FirestoreConfig): VectorStore {
  const sa = cfg.client ? undefined : parseServiceAccount(cfg.serviceAccountJson);
  const projectId = cfg.projectId ?? sa?.project_id ?? "test";
  const db =
    cfg.client ??
    new Firestore({
      projectId,
      databaseId: cfg.databaseId,
      credentials: { client_email: sa?.client_email, private_key: sa?.private_key },
    });
  const col = (kb: KbRef) => db.collection(firestoreCollection(kb));
  const wrap = async <T>(kb: KbRef | undefined, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VectorStoreError) throw err;
      const e = err as { code?: number; message?: string };
      // 9 = FAILED_PRECONDITION: the vector index for this collection does not exist yet.
      if (e.code === 9 && kb) {
        throw new VectorStoreError(
          "Firestore needs a vector index for this knowledge base before it can be searched.",
          firestoreIndexCommand(projectId, firestoreCollection(kb), kb.dimension, cfg.databaseId),
        );
      }
      const status =
        e.code === 7 ? 403 : e.code === 16 ? 401 : e.code === 5 ? 404 : e.code === 8 ? 429 : undefined;
      throw toProviderError({ status, message: e.message ?? String(err) });
    }
  };

  async function deleteWhere(kb: KbRef, field: string, value: string) {
    for (;;) {
      const snap = await col(kb).where(field, "==", value).limit(400).get();
      if (snap.empty) return;
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
    }
  }

  return {
    provider: "firestore",

    ensureIndex: async (kb) => {
      if (kb.dimension > FIRESTORE_MAX_DIMENSION) {
        throw new VectorStoreError(
          `Firestore supports at most ${FIRESTORE_MAX_DIMENSION} dimensions; this embedding model produces ${kb.dimension}.`,
        );
      }
    },

    upsert: (kb, items) =>
      wrap(kb, async () => {
        for (let i = 0; i < items.length; i += 400) {
          const batch = db.batch();
          for (const it of items.slice(i, i + 400)) {
            batch.set(col(kb).doc(it.id), {
              embedding: FieldValue.vector(it.vector),
              documentId: it.metadata.documentId,
              audience: it.metadata.audience,
            });
          }
          await batch.commit();
        }
      }),

    query: (kb, vector, opts) =>
      wrap(kb, async () => {
        const snap = await col(kb)
          .where("audience", "in", opts.audiences)
          .findNearest({
            vectorField: "embedding",
            queryVector: vector,
            limit: opts.topK,
            distanceMeasure: "COSINE",
            distanceResultField: "_distance",
          })
          .get();
        return snap.docs.map(
          (d): VectorMatch => ({
            id: d.id,
            score: scoreFromCosineDistance(Number(d.get("_distance") ?? 2)),
            documentId: String(d.get("documentId") ?? ""),
          }),
        );
      }),

    deleteIds: (kb, ids) =>
      wrap(kb, async () => {
        for (let i = 0; i < ids.length; i += 400) {
          const batch = db.batch();
          for (const id of ids.slice(i, i + 400)) batch.delete(col(kb).doc(id));
          await batch.commit();
        }
      }),

    deleteByDocument: (kb, documentId) => wrap(kb, () => deleteWhere(kb, "documentId", documentId)),

    deleteNamespace: (kb) => wrap(kb, () => db.recursiveDelete(col(kb))),

    healthcheck: (expect) =>
      timed(async () => {
        if (expect?.dimension && expect.dimension > FIRESTORE_MAX_DIMENSION) {
          throw new VectorStoreError(
            `Firestore supports at most ${FIRESTORE_MAX_DIMENSION} dimensions; choose an embedding size of ${FIRESTORE_MAX_DIMENSION} or less.`,
          );
        }
        await wrap(undefined, () => db.listCollections());
        return { message: `Connected to Firestore project "${projectId}".` };
      }),
  };
}
