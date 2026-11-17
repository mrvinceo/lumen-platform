import { randomUUID } from "node:crypto";
import { type Audience, detectFormat, ParseError, SUPPORTED_EXTENSIONS } from "@lumen/core";
import { and, desc, eq, inArray, ne, schema, sql, type Tx, withTenant } from "@lumen/db";
import {
  deleteDocument,
  ensureManagedStore,
  type IngestionQueue,
  loadKnowledgeBase,
  objectKey,
  type RuntimeDeps,
  searchKnowledgeBase,
  vectorStoreFromRow,
} from "@lumen/runtime";
import "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { audit } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { type RequestContext, requireRole, requireTenant } from "../lib/tenantContext.js";
import { parse } from "../lib/validate.js";
import { recordCheck } from "./vectorStores.js";

export interface KnowledgeRouteDeps {
  runtime: RuntimeDeps;
  auth: Auth;
  queue: IngestionQueue;
  maxUploadMb: number;
}

const audienceSchema = z.enum(["public", "staff"]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  embeddingConfigId: z.uuid(),
  /** Omit to use the built-in managed store. */
  vectorStoreId: z.uuid().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  embeddingConfigId: z.uuid().optional(),
});

const searchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  audiences: z.array(audienceSchema).min(1).default(["public", "staff"]),
  topK: z.number().int().min(1).max(20).default(6),
});

async function getKb(tx: Tx, tenantId: string, id: string) {
  const [kb] = await tx
    .select()
    .from(schema.knowledgeBases)
    .where(
      and(
        eq(schema.knowledgeBases.id, id),
        eq(schema.knowledgeBases.tenantId, tenantId),
        ne(schema.knowledgeBases.status, "disabled"),
      ),
    );
  if (!kb) throw notFound("Knowledge base");
  return kb;
}

async function uploadSource(tx: Tx, tenantId: string, kbId: string) {
  const [existing] = await tx
    .select()
    .from(schema.sources)
    .where(and(eq(schema.sources.kbId, kbId), eq(schema.sources.type, "upload")));
  if (existing) return existing;
  const [created] = await tx
    .insert(schema.sources)
    .values({ tenantId, kbId, type: "upload", name: "Uploads" })
    .returning();
  if (!created) throw new Error("insert returned no row");
  return created;
}

const kbSummary = sql`
  select k.id, k.name, k.description, k.dimension, k.status, k.created_at as "createdAt",
         p.id as "embeddingConfigId", p.label as "embeddingLabel", p.provider as "embeddingProvider", p.model as "embeddingModel",
         v.id as "vectorStoreId", v.label as "vectorStoreLabel", v.provider as "vectorStoreProvider",
         (select count(*)::int from documents d where d.kb_id = k.id) as "documentCount",
         (select count(*)::int from documents d where d.kb_id = k.id and d.status = 'indexed') as "indexedCount",
         (select count(*)::int from documents d where d.kb_id = k.id and d.status in ('pending', 'indexing')) as "pendingCount",
         (select count(*)::int from documents d where d.kb_id = k.id and d.status = 'error') as "errorCount",
         (select coalesce(sum(d.chunk_count), 0)::int from documents d where d.kb_id = k.id) as "chunkCount"
  from knowledge_bases k
  join provider_configs p on p.id = k.embedding_config_id
  join vector_stores v on v.id = k.vector_store_id
  where k.status <> 'disabled'`;

type DocumentRow = typeof schema.documents.$inferSelect;
const presentDoc = (d: DocumentRow) => ({
  id: d.id,
  title: d.title,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  audience: d.audience,
  status: d.status,
  error: d.error,
  chunkCount: d.chunkCount,
  tokenCount: d.tokenCount,
  indexedAt: d.indexedAt,
  createdAt: d.createdAt,
});

export async function knowledgeRoutes(app: FastifyInstance, deps: KnowledgeRouteDeps): Promise<void> {
  const { runtime, auth, queue } = deps;
  const db = runtime.db;
  const ctxOf = (req: Parameters<typeof requireTenant>[2]) => requireTenant(auth, db, req);

  /** Creates the job row and queues it; the document shows "pending" until the worker picks it up. */
  async function queueIngest(ctx: RequestContext, docs: { id: string; sourceId: string }[]) {
    const jobs = await withTenant(db, ctx.tenantId, (tx) =>
      Promise.all(
        docs.map(async (d) => {
          const [job] = await tx
            .insert(schema.ingestionJobs)
            .values({ tenantId: ctx.tenantId, sourceId: d.sourceId, documentId: d.id, kind: "ingest" })
            .returning({ id: schema.ingestionJobs.id });
          if (!job) throw new Error("insert returned no row");
          return { documentId: d.id, jobId: job.id };
        }),
      ),
    );
    for (const j of jobs) {
      await queue.enqueue({
        name: "ingest-document",
        data: { tenantId: ctx.tenantId, documentId: j.documentId, jobId: j.jobId },
      });
    }
  }

  app.get("/api/v1/knowledge-bases", async (req) => {
    const ctx = await ctxOf(req);
    const rows = await withTenant(db, ctx.tenantId, (tx) =>
      tx.execute(sql`${kbSummary} order by k.created_at desc`),
    );
    return { knowledgeBases: rows };
  });

  app.get<{ Params: { id: string } }>("/api/v1/knowledge-bases/:id", async (req) => {
    const ctx = await ctxOf(req);
    const id = parse(z.uuid(), req.params.id);
    const [row] = await withTenant(db, ctx.tenantId, (tx) => tx.execute(sql`${kbSummary} and k.id = ${id}`));
    if (!row) throw notFound("Knowledge base");
    return { knowledgeBase: row };
  });

  app.post("/api/v1/knowledge-bases", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const body = parse(createSchema, req.body);
    const id = randomUUID();

    // Resolve the embedding model's dimension and check the chosen store can hold it.
    const { embedding, storeRow, adapter } = await withTenant(db, ctx.tenantId, async (tx) => {
      const [embedding] = await tx
        .select()
        .from(schema.providerConfigs)
        .where(
          and(
            eq(schema.providerConfigs.id, body.embeddingConfigId),
            eq(schema.providerConfigs.type, "embedding"),
          ),
        );
      if (!embedding)
        throw new HttpError(
          400,
          "invalid_embedding_model",
          "Choose an embedding model from the Models page.",
        );
      const storeRow = body.vectorStoreId
        ? (
            await tx.select().from(schema.vectorStores).where(eq(schema.vectorStores.id, body.vectorStoreId))
          )[0]
        : await ensureManagedStore(tx, ctx.tenantId);
      if (!storeRow) throw notFound("Vector store");
      return { embedding, storeRow, adapter: await vectorStoreFromRow(tx, runtime, storeRow) };
    });
    const dimension = (embedding.options as { dimension?: number }).dimension;
    if (!dimension)
      throw new HttpError(400, "invalid_embedding_model", "This embedding model has no vector size set.");
    const ref = { tenantId: ctx.tenantId, kbId: id, namespace: `kb_${id}`, dimension };
    try {
      await adapter.ensureIndex(ref);
    } catch (err) {
      const e = err as { message?: string; action?: string };
      throw new HttpError(
        422,
        "vector_store_incompatible",
        e.message ?? "The vector store can't hold this knowledge base.",
        {
          action: e.action,
        },
      );
    }
    if (storeRow.provider !== "pgvector_managed") {
      const health = await adapter.healthcheck({ dimension });
      await withTenant(db, ctx.tenantId, (tx) => recordCheck(tx, storeRow.id, health));
      if (!health.ok) throw new HttpError(422, "vector_store_incompatible", health.message, health);
    }

    await withTenant(db, ctx.tenantId, async (tx) => {
      await tx.insert(schema.knowledgeBases).values({
        id,
        tenantId: ctx.tenantId,
        name: body.name,
        description: body.description,
        embeddingConfigId: embedding.id,
        vectorStoreId: storeRow.id,
        dimension,
        namespace: ref.namespace,
      });
      await uploadSource(tx, ctx.tenantId, id);
      await audit(tx, ctx, "knowledge_base.created", id, { vectorStore: storeRow.provider });
    });
    const [row] = await withTenant(db, ctx.tenantId, (tx) => tx.execute(sql`${kbSummary} and k.id = ${id}`));
    return reply.code(201).send({ knowledgeBase: row });
  });

  app.patch<{ Params: { id: string } }>("/api/v1/knowledge-bases/:id", async (req) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const id = parse(z.uuid(), req.params.id);
    const patch = parse(updateSchema, req.body);
    await withTenant(db, ctx.tenantId, async (tx) => {
      const kb = await getKb(tx, ctx.tenantId, id);
      if (patch.embeddingConfigId && patch.embeddingConfigId !== kb.embeddingConfigId) {
        throw new HttpError(
          400,
          "embedding_model_locked",
          "A knowledge base's embedding model can't be changed yet, because every document would need re-embedding. Create a new knowledge base instead.",
        );
      }
      await tx
        .update(schema.knowledgeBases)
        .set({
          name: patch.name ?? kb.name,
          description: patch.description === undefined ? kb.description : patch.description,
        })
        .where(eq(schema.knowledgeBases.id, id));
      await audit(tx, ctx, "knowledge_base.updated", id);
    });
    const [row] = await withTenant(db, ctx.tenantId, (tx) => tx.execute(sql`${kbSummary} and k.id = ${id}`));
    return { knowledgeBase: row };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/knowledge-bases/:id", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const id = parse(z.uuid(), req.params.id);
    await withTenant(db, ctx.tenantId, async (tx) => {
      await getKb(tx, ctx.tenantId, id);
      // Hide it immediately; the worker removes vectors, files and rows.
      await tx
        .update(schema.knowledgeBases)
        .set({ status: "disabled" })
        .where(eq(schema.knowledgeBases.id, id));
      await audit(tx, ctx, "knowledge_base.deleted", id);
    });
    await queue.enqueue({ name: "delete-knowledge-base", data: { tenantId: ctx.tenantId, kbId: id } });
    return reply.code(202).send({ status: "deleting" });
  });

  app.get<{ Params: { id: string } }>("/api/v1/knowledge-bases/:id/documents", async (req) => {
    const ctx = await ctxOf(req);
    const id = parse(z.uuid(), req.params.id);
    const docs = await withTenant(db, ctx.tenantId, async (tx) => {
      await getKb(tx, ctx.tenantId, id);
      return tx
        .select()
        .from(schema.documents)
        .where(eq(schema.documents.kbId, id))
        .orderBy(desc(schema.documents.createdAt));
    });
    return { documents: docs.map(presentDoc) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/knowledge-bases/:id/documents", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "editor");
    const id = parse(z.uuid(), req.params.id);
    if (!req.isMultipart())
      throw new HttpError(415, "multipart_required", "Upload files as multipart/form-data.");
    const { kb, source } = await withTenant(db, ctx.tenantId, async (tx) => {
      const kb = await getKb(tx, ctx.tenantId, id);
      return { kb, source: await uploadSource(tx, ctx.tenantId, kb.id) };
    });

    let audience: Audience = "public";
    const accepted: DocumentRow[] = [];
    const rejected: { filename: string; reason: string }[] = [];
    // Oversized files come back truncated (throwFileSizeLimit: false in app.ts), so one big file is rejected on its own.
    for await (const part of req.parts({ limits: { fileSize: deps.maxUploadMb * 1024 * 1024, files: 50 } })) {
      if (part.type === "field") {
        if (part.fieldname === "audience") audience = parse(audienceSchema, part.value);
        continue;
      }
      const filename = part.filename || "upload";
      const bytes = new Uint8Array(await part.toBuffer());
      if (part.file.truncated) {
        rejected.push({ filename, reason: `Larger than ${deps.maxUploadMb} MB.` });
        continue;
      }
      try {
        detectFormat(bytes, filename, part.mimetype);
      } catch (err) {
        rejected.push({ filename, reason: err instanceof ParseError ? err.message : "Unsupported file." });
        continue;
      }
      const documentId = randomUUID();
      const key = objectKey(ctx.tenantId, kb.id, documentId, filename);
      await runtime.objects.put(key, bytes, part.mimetype);
      const [doc] = await withTenant(db, ctx.tenantId, (tx) =>
        tx
          .insert(schema.documents)
          .values({
            id: documentId,
            tenantId: ctx.tenantId,
            kbId: kb.id,
            sourceId: source.id,
            externalId: documentId,
            title: filename,
            mimeType: part.mimetype,
            sizeBytes: bytes.byteLength,
            storageKey: key,
            audience,
          })
          .returning(),
      );
      if (doc) accepted.push(doc);
    }
    if (accepted.length === 0 && rejected.length === 0)
      throw new HttpError(400, "no_files", "No files were uploaded.");
    await queueIngest(
      ctx,
      accepted.map((d) => ({ id: d.id, sourceId: source.id })),
    );
    if (accepted.length) {
      await withTenant(db, ctx.tenantId, (tx) =>
        audit(tx, ctx, "documents.uploaded", kb.id, { count: accepted.length, audience }),
      );
    }
    return reply.code(accepted.length ? 201 : 400).send({ documents: accepted.map(presentDoc), rejected });
  });

  app.post<{ Params: { id: string; docId: string } }>(
    "/api/v1/knowledge-bases/:id/documents/:docId/reindex",
    async (req) => {
      const ctx = await ctxOf(req);
      requireRole(ctx, "editor");
      const id = parse(z.uuid(), req.params.id);
      const docId = parse(z.uuid(), req.params.docId);
      const doc = await withTenant(db, ctx.tenantId, async (tx) => {
        await getKb(tx, ctx.tenantId, id);
        const [d] = await tx
          .update(schema.documents)
          // Clearing the hash forces a full rebuild rather than an "unchanged" skip.
          .set({ status: "pending", error: null, contentHash: null })
          .where(and(eq(schema.documents.id, docId), eq(schema.documents.kbId, id)))
          .returning();
        if (!d) throw notFound("Document");
        return d;
      });
      await queueIngest(ctx, [{ id: doc.id, sourceId: doc.sourceId }]);
      return { document: presentDoc(doc) };
    },
  );

  app.delete<{ Params: { id: string; docId: string } }>(
    "/api/v1/knowledge-bases/:id/documents/:docId",
    async (req, reply) => {
      const ctx = await ctxOf(req);
      requireRole(ctx, "editor");
      const id = parse(z.uuid(), req.params.id);
      const docId = parse(z.uuid(), req.params.docId);
      await withTenant(db, ctx.tenantId, async (tx) => {
        await getKb(tx, ctx.tenantId, id);
        const [d] = await tx
          .select({ id: schema.documents.id })
          .from(schema.documents)
          .where(and(eq(schema.documents.id, docId), eq(schema.documents.kbId, id)));
        if (!d) throw notFound("Document");
      });
      try {
        await deleteDocument(runtime, { tenantId: ctx.tenantId, documentId: docId });
      } catch (err) {
        const e = err as { message?: string };
        throw new HttpError(
          502,
          "delete_failed",
          `Could not remove the document's vectors: ${e.message ?? "unknown error"}`,
        );
      }
      await withTenant(db, ctx.tenantId, (tx) => audit(tx, ctx, "document.deleted", docId));
      return reply.code(204).send();
    },
  );

  /** Retrieval preview: embeds the query and shows the best-matching chunks. Not the chat pipeline. */
  app.post<{ Params: { id: string } }>("/api/v1/knowledge-bases/:id/search", async (req) => {
    const ctx = await ctxOf(req);
    const id = parse(z.uuid(), req.params.id);
    const body = parse(searchSchema, req.body ?? {});
    const loaded = await withTenant(db, ctx.tenantId, async (tx) => {
      await getKb(tx, ctx.tenantId, id);
      return loadKnowledgeBase(tx, runtime, ctx.tenantId, id);
    });
    const started = performance.now();
    let result: Awaited<ReturnType<typeof searchKnowledgeBase>>;
    try {
      result = await searchKnowledgeBase(
        loaded,
        body.query,
        { audiences: body.audiences, topK: body.topK },
        (ids) =>
          withTenant(db, ctx.tenantId, (tx) =>
            tx
              .select({
                id: schema.chunks.id,
                text: schema.chunks.text,
                metadata: schema.chunks.metadata,
                audience: schema.chunks.audience,
                documentId: schema.chunks.documentId,
                title: schema.documents.title,
              })
              .from(schema.chunks)
              .innerJoin(schema.documents, eq(schema.documents.id, schema.chunks.documentId))
              .where(and(inArray(schema.chunks.id, ids), eq(schema.chunks.kbId, id))),
          ),
      );
    } catch (err) {
      const e = err as { message?: string; action?: string; code?: string };
      throw new HttpError(
        502,
        "search_failed",
        e.message ?? "Search failed.",
        e.action ? { action: e.action } : undefined,
      );
    }
    await withTenant(db, ctx.tenantId, (tx) =>
      tx.insert(schema.usageEvents).values({
        tenantId: ctx.tenantId,
        kind: "embedding_query",
        provider: loaded.embedder.provider,
        model: loaded.embedder.model,
        tokensIn: result.tokens,
      }),
    );
    return { hits: result.hits, latencyMs: Math.round(performance.now() - started) };
  });

  app.get("/api/v1/uploads/formats", async () => ({
    extensions: SUPPORTED_EXTENSIONS,
    maxUploadMb: deps.maxUploadMb,
  }));
}
