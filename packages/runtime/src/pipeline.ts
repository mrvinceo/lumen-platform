import {
  type Chunk,
  chunkSections,
  ParseError,
  ProviderError,
  parseDocument,
  sha256,
  type VectorItem,
  VectorStoreError,
} from "@lumen/core";
import { and, eq, inArray, schema, withTenant } from "@lumen/db";
import { documentPrefix, kbPrefix } from "./objectStore.js";
import { type LoadedKnowledgeBase, loadKnowledgeBase, type RuntimeDeps } from "./resolve.js";

/** Deterministic UUID (v8 layout) from text, so a chunk keeps its id while its content and position don't change. */
export function stableId(text: string): string {
  const h = sha256(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const chunkId = (
  documentId: string,
  audience: string,
  chunk: Pick<Chunk, "ordinal" | "contentHash">,
) => stableId(`${documentId}:${audience}:${chunk.ordinal}:${chunk.contentHash}`);

export interface IngestResult {
  status: "indexed" | "unchanged" | "error";
  chunks: number;
  embedded: number;
  tokens: number;
  error?: string;
  /** True when a later attempt might succeed (rate limits, network, provider outages). */
  retryable?: boolean;
}

export interface IngestOptions {
  onProgress?: (pct: number) => Promise<void> | void;
  /** Delay before retrying a rate-limited embedding batch; shortened in tests. */
  retryDelayMs?: number;
}

const RETRYABLE = new Set(["rate_limit", "provider", "network"]);

/** Readable message for anything that can go wrong while ingesting. */
export function describeIngestError(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof ParseError) return { message: err.message, retryable: false };
  if (err instanceof VectorStoreError) {
    return { message: err.action ? `${err.message} ${err.action}` : err.message, retryable: false };
  }
  if (err instanceof ProviderError) return { message: err.message, retryable: RETRYABLE.has(err.code) };
  return { message: "Unexpected error while indexing this document.", retryable: true };
}

async function withRetry<T>(fn: () => Promise<T>, delayMs: number, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const pe = err as ProviderError;
      if (i >= attempts || !(pe instanceof ProviderError) || !RETRYABLE.has(pe.code)) throw err;
      await new Promise((r) => setTimeout(r, delayMs * 2 ** (i - 1)));
    }
  }
}

/**
 * Parses, chunks, embeds and stores one document. Unchanged chunks keep their ids and vectors, so editing a
 * document only re-embeds what changed. Never throws for document problems: the outcome (including any error)
 * is written to the document and job rows and returned.
 */
export async function ingestDocument(
  deps: RuntimeDeps,
  input: { tenantId: string; documentId: string; jobId?: string },
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const { tenantId, documentId, jobId } = input;
  const progress = async (pct: number) => {
    await opts.onProgress?.(pct);
    if (jobId) {
      await withTenant(deps.db, tenantId, (tx) =>
        tx.update(schema.ingestionJobs).set({ progress: pct }).where(eq(schema.ingestionJobs.id, jobId)),
      );
    }
  };

  const setup = await withTenant(deps.db, tenantId, async (tx) => {
    const [doc] = await tx.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    if (!doc) return undefined;
    const loaded = await loadKnowledgeBase(tx, deps, tenantId, doc.kbId);
    const previousStatus = doc.status;
    await tx
      .update(schema.documents)
      .set({ status: "indexing", error: null })
      .where(eq(schema.documents.id, documentId));
    if (jobId) {
      await tx
        .update(schema.ingestionJobs)
        .set({ status: "running", startedAt: new Date(), progress: 0, error: null })
        .where(eq(schema.ingestionJobs.id, jobId));
    }
    return { doc, loaded, previousStatus };
  }).catch((err: unknown) => ({ failed: err }) as const);

  if (!setup) return { status: "error", chunks: 0, embedded: 0, tokens: 0, error: "Document not found." };
  if ("failed" in setup) return fail(deps, input, setup.failed);
  const { doc, loaded, previousStatus } = setup;

  try {
    if (!doc.storageKey) throw new ParseError("corrupt", "The original file is missing.");
    const bytes = await deps.objects.get(doc.storageKey);
    const parsed = await parseDocument(bytes, doc.title, doc.mimeType ?? undefined);
    const chunks = chunkSections(parsed.sections);
    const contentHash = sha256(`${doc.audience}:${chunks.map((c) => c.contentHash).join(":")}`);
    await progress(10);

    if (previousStatus === "indexed" && doc.contentHash === contentHash) {
      await finish(deps, input, {
        status: "indexed",
        contentHash,
        chunks: chunks.length,
        tokens: doc.tokenCount,
        embedded: 0,
      });
      return { status: "unchanged", chunks: chunks.length, embedded: 0, tokens: 0 };
    }

    const withIds = chunks.map((c) => ({ ...c, id: chunkId(documentId, doc.audience, c) }));
    const wanted = new Set(withIds.map((c) => c.id));

    // 1. Replace the chunk rows: drop stale ones (their managed vectors cascade), add new ones.
    const { stale, fresh } = await withTenant(deps.db, tenantId, async (tx) => {
      const existing = await tx
        .select({ id: schema.chunks.id })
        .from(schema.chunks)
        .where(eq(schema.chunks.documentId, documentId));
      const have = new Set(existing.map((e) => e.id));
      const staleIds = existing.map((e) => e.id).filter((id) => !wanted.has(id));
      if (staleIds.length) await tx.delete(schema.chunks).where(inArray(schema.chunks.id, staleIds));
      const freshChunks = withIds.filter((c) => !have.has(c.id));
      for (let i = 0; i < freshChunks.length; i += 500) {
        await tx.insert(schema.chunks).values(
          freshChunks.slice(i, i + 500).map((c) => ({
            id: c.id,
            tenantId,
            kbId: doc.kbId,
            documentId,
            ordinal: c.ordinal,
            text: c.text,
            tokenCount: c.tokenCount,
            contentHash: c.contentHash,
            audience: doc.audience,
            metadata: { headings: c.headings, ...(c.page ? { page: c.page } : {}) },
          })),
        );
      }
      return { stale: staleIds, fresh: freshChunks };
    });
    await progress(20);

    // 2. Embed only new chunks, in batches, retrying transient provider errors.
    let tokens = 0;
    const batchSize = Math.min(loaded.embedder.maxBatch, 64);
    for (let i = 0; i < fresh.length; i += batchSize) {
      const batch = fresh.slice(i, i + batchSize);
      const res = await withRetry(
        () =>
          loaded.embedder.embed(
            batch.map((c) => embeddingInput(doc.title, c.text)),
            "document",
          ),
        opts.retryDelayMs ?? 2_000,
      );
      tokens += res.tokens || batch.reduce((n, c) => n + c.tokenCount, 0);
      const items: VectorItem[] = batch.map((c, j) => ({
        id: c.id,
        vector: res.vectors[j] ?? [],
        metadata: { documentId, audience: doc.audience },
      }));
      await upsertChecked(loaded, items);
      await progress(20 + Math.round(((i + batch.length) / fresh.length) * 75));
    }

    // 3. Remove vectors for chunks that no longer exist (managed store already did via cascade).
    if (stale.length) await loaded.store.deleteIds(loaded.ref, stale);

    const totalTokens = withIds.reduce((n, c) => n + c.tokenCount, 0);
    await finish(
      deps,
      input,
      { status: "indexed", contentHash, chunks: withIds.length, tokens: totalTokens, embedded: fresh.length },
      {
        embeddingTokens: tokens,
        loaded,
      },
    );
    return { status: "indexed", chunks: withIds.length, embedded: fresh.length, tokens };
  } catch (err) {
    return fail(deps, input, err);
  }
}

/** A little document context makes chunk embeddings noticeably better at matching questions. */
const embeddingInput = (title: string, text: string) => `Document: ${title}\n\n${text}`;

async function upsertChecked(loaded: LoadedKnowledgeBase, items: VectorItem[]) {
  for (const it of items) {
    if (it.vector.length !== loaded.ref.dimension) {
      throw new VectorStoreError(
        `The embedding model returned ${it.vector.length}-dimensional vectors but this knowledge base uses ${loaded.ref.dimension}.`,
      );
    }
  }
  await loaded.store.upsert(loaded.ref, items);
}

async function finish(
  deps: RuntimeDeps,
  input: { tenantId: string; documentId: string; jobId?: string },
  r: { status: "indexed"; contentHash: string; chunks: number; tokens: number; embedded: number },
  usage?: { embeddingTokens: number; loaded: LoadedKnowledgeBase },
) {
  await withTenant(deps.db, input.tenantId, async (tx) => {
    await tx
      .update(schema.documents)
      .set({
        status: r.status,
        contentHash: r.contentHash,
        chunkCount: r.chunks,
        tokenCount: r.tokens,
        indexedAt: new Date(),
        error: null,
      })
      .where(eq(schema.documents.id, input.documentId));
    if (input.jobId) {
      await tx
        .update(schema.ingestionJobs)
        .set({
          status: "succeeded",
          progress: 100,
          finishedAt: new Date(),
          stats: {
            files: 1,
            chunks: r.chunks,
            tokens: usage?.embeddingTokens ?? 0,
            skipped: r.embedded === 0 ? 1 : 0,
          },
        })
        .where(eq(schema.ingestionJobs.id, input.jobId));
    }
    if (usage && usage.embeddingTokens > 0) {
      await tx.insert(schema.usageEvents).values({
        tenantId: input.tenantId,
        kind: "embedding_ingest",
        provider: usage.loaded.embedder.provider,
        model: usage.loaded.embedder.model,
        tokensIn: usage.embeddingTokens,
      });
    }
  });
}

async function fail(
  deps: RuntimeDeps,
  input: { tenantId: string; documentId: string; jobId?: string },
  err: unknown,
): Promise<IngestResult> {
  const { message, retryable } = describeIngestError(err);
  await withTenant(deps.db, input.tenantId, async (tx) => {
    await tx
      .update(schema.documents)
      .set({ status: "error", error: message })
      .where(eq(schema.documents.id, input.documentId));
    if (input.jobId) {
      await tx
        .update(schema.ingestionJobs)
        .set({ status: "failed", error: message, finishedAt: new Date() })
        .where(eq(schema.ingestionJobs.id, input.jobId));
    }
  });
  return { status: "error", chunks: 0, embedded: 0, tokens: 0, error: message, retryable };
}

/** Removes a document everywhere: vectors, stored original, chunk rows and the document row. */
export async function deleteDocument(
  deps: RuntimeDeps,
  input: { tenantId: string; documentId: string },
): Promise<void> {
  const found = await withTenant(deps.db, input.tenantId, async (tx) => {
    const [doc] = await tx.select().from(schema.documents).where(eq(schema.documents.id, input.documentId));
    if (!doc) return undefined;
    return { doc, loaded: await loadKnowledgeBase(tx, deps, input.tenantId, doc.kbId) };
  });
  if (!found) return;
  await found.loaded.store.deleteByDocument(found.loaded.ref, input.documentId);
  await deps.objects.deletePrefix(documentPrefix(input.tenantId, found.doc.kbId, input.documentId));
  await withTenant(deps.db, input.tenantId, (tx) =>
    tx
      .delete(schema.documents)
      .where(and(eq(schema.documents.id, input.documentId), eq(schema.documents.tenantId, input.tenantId))),
  );
}

/** Removes a knowledge base everywhere: its namespace/collection, stored originals and all rows. */
export async function deleteKnowledgeBase(
  deps: RuntimeDeps,
  input: { tenantId: string; kbId: string },
): Promise<void> {
  const loaded = await withTenant(deps.db, input.tenantId, (tx) =>
    loadKnowledgeBase(tx, deps, input.tenantId, input.kbId).catch(() => undefined),
  );
  if (loaded) await loaded.store.deleteNamespace(loaded.ref);
  await deps.objects.deletePrefix(kbPrefix(input.tenantId, input.kbId));
  await withTenant(deps.db, input.tenantId, (tx) =>
    tx.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, input.kbId)),
  );
}
