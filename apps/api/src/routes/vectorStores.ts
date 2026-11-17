import {
  firestoreVectorStore,
  type HealthResult,
  parseServiceAccount,
  pineconeVectorStore,
  type VectorStore,
} from "@lumen/core";
import { maskSecret } from "@lumen/crypto";
import { and, desc, eq, schema, sql, type Tx, withTenant } from "@lumen/db";
import {
  ensureManagedStore,
  MANAGED_STORE_LABEL,
  type RuntimeDeps,
  storeSecret,
  type VectorStoreRow,
  vectorStoreFromRow,
} from "@lumen/runtime";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { audit, isForeignKeyViolation } from "../lib/db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { requireRole, requireTenant } from "../lib/tenantContext.js";
import { parse } from "../lib/validate.js";

export interface VectorStoreRouteDeps {
  runtime: RuntimeDeps;
  auth: Auth;
}

const createSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("pinecone"),
    label: z.string().trim().min(1).max(100).optional(),
    apiKey: z.string().trim().min(8).max(500),
    indexName: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,45}$/, "Pinecone index names use lowercase letters, numbers and hyphens."),
  }),
  z.object({
    provider: z.literal("firestore"),
    label: z.string().trim().min(1).max(100).optional(),
    serviceAccountJson: z.string().trim().min(20).max(20_000),
    databaseId: z.string().trim().max(100).optional(),
  }),
]);

const PROVIDER_NAMES: Record<string, string> = {
  pgvector_managed: "Lumen managed",
  pinecone: "Pinecone",
  firestore: "Google Firestore",
};

type Row = VectorStoreRow & { last4: string | null; inUse: number };

function present(row: Row) {
  return {
    id: row.id,
    provider: row.provider,
    providerName: PROVIDER_NAMES[row.provider] ?? row.provider,
    label: row.label,
    managed: row.provider === "pgvector_managed",
    config: row.config,
    keyHint: row.secretId ? maskSecret(row.last4 ?? "") : null,
    lastCheck: row.lastCheckedAt
      ? { ok: row.lastCheckOk, message: row.lastCheckMessage, checkedAt: row.lastCheckedAt }
      : null,
    knowledgeBases: row.inUse,
    createdAt: row.createdAt,
  };
}

async function listRows(tx: Tx, tenantId: string, id?: string): Promise<Row[]> {
  const rows = await tx
    .select({
      store: schema.vectorStores,
      last4: schema.secrets.last4,
      inUse: sql<number>`(select count(*)::int from knowledge_bases k where k.vector_store_id = ${schema.vectorStores.id} and k.status <> 'disabled')`,
    })
    .from(schema.vectorStores)
    .leftJoin(schema.secrets, eq(schema.secrets.id, schema.vectorStores.secretId))
    .where(id ? and(eq(schema.vectorStores.id, id), eq(schema.vectorStores.tenantId, tenantId)) : undefined)
    .orderBy(desc(schema.vectorStores.createdAt));
  return rows.map((r) => ({ ...r.store, last4: r.last4, inUse: r.inUse }));
}

export async function recordCheck(tx: Tx, id: string, h: HealthResult) {
  await tx
    .update(schema.vectorStores)
    .set({
      lastCheckOk: h.ok,
      lastCheckMessage: h.action ? `${h.message} ${h.action}` : h.message,
      lastCheckedAt: new Date(),
    })
    .where(eq(schema.vectorStores.id, id));
}

export async function vectorStoreRoutes(app: FastifyInstance, deps: VectorStoreRouteDeps): Promise<void> {
  const { runtime, auth } = deps;
  const db = runtime.db;
  const ctxOf = (req: Parameters<typeof requireTenant>[2]) => requireTenant(auth, db, req);

  app.get("/api/v1/vector-stores", async (req) => {
    const ctx = await ctxOf(req);
    const rows = await withTenant(db, ctx.tenantId, async (tx) => {
      await ensureManagedStore(tx, ctx.tenantId);
      return listRows(tx, ctx.tenantId);
    });
    // Managed store first, then newest.
    rows.sort(
      (a, b) => Number(b.provider === "pgvector_managed") - Number(a.provider === "pgvector_managed"),
    );
    return { vectorStores: rows.map(present) };
  });

  app.post("/api/v1/vector-stores", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const body = parse(createSchema, req.body);

    let adapter: VectorStore;
    let config: Record<string, unknown>;
    let label: string;
    let secretValue: string;
    if (body.provider === "pinecone") {
      adapter = pineconeVectorStore({ apiKey: body.apiKey, indexName: body.indexName, fetch: runtime.fetch });
      config = { indexName: body.indexName };
      label = body.label ?? `Pinecone · ${body.indexName}`;
      secretValue = body.apiKey;
    } else {
      let sa: { project_id: string };
      try {
        sa = parseServiceAccount(body.serviceAccountJson);
      } catch (err) {
        throw new HttpError(400, "invalid_credentials", (err as Error).message);
      }
      adapter = firestoreVectorStore({
        serviceAccountJson: body.serviceAccountJson,
        databaseId: body.databaseId,
      });
      config = { projectId: sa.project_id, ...(body.databaseId ? { databaseId: body.databaseId } : {}) };
      label = body.label ?? `Firestore · ${sa.project_id}`;
      secretValue = body.serviceAccountJson;
    }

    const health = await adapter.healthcheck();
    if (!health.ok) throw new HttpError(422, "connection_failed", health.message, health);

    const row = await withTenant(db, ctx.tenantId, async (tx) => {
      const secret = await storeSecret(tx, runtime.keys, {
        tenantId: ctx.tenantId,
        kind: body.provider === "pinecone" ? "vector_store_credential" : "service_account",
        label: `${label} credential`,
        value: secretValue,
      });
      const [created] = await tx
        .insert(schema.vectorStores)
        .values({ tenantId: ctx.tenantId, provider: body.provider, label, secretId: secret.id, config })
        .returning();
      if (!created) throw new Error("insert returned no row");
      await recordCheck(tx, created.id, health);
      await audit(tx, ctx, "vector_store.created", created.id, { provider: body.provider });
      const [r] = await listRows(tx, ctx.tenantId, created.id);
      return r;
    });
    return reply.code(201).send({ vectorStore: row && present(row) });
  });

  app.post<{ Params: { id: string } }>("/api/v1/vector-stores/:id/test", async (req) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "editor");
    const id = parse(z.uuid(), req.params.id);
    const { adapter } = await withTenant(db, ctx.tenantId, async (tx) => {
      const [row] = await listRows(tx, ctx.tenantId, id);
      if (!row) throw notFound("Vector store");
      return { adapter: await vectorStoreFromRow(tx, runtime, row) };
    });
    const result = await adapter.healthcheck();
    await withTenant(db, ctx.tenantId, (tx) => recordCheck(tx, id, result));
    return { result };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/vector-stores/:id", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const id = parse(z.uuid(), req.params.id);
    try {
      await withTenant(db, ctx.tenantId, async (tx) => {
        const [row] = await listRows(tx, ctx.tenantId, id);
        if (!row) throw notFound("Vector store");
        if (row.provider === "pgvector_managed") {
          throw new HttpError(
            400,
            "managed_store",
            `${MANAGED_STORE_LABEL} is built in and can't be removed.`,
          );
        }
        await tx.delete(schema.vectorStores).where(eq(schema.vectorStores.id, id));
        if (row.secretId) await tx.delete(schema.secrets).where(eq(schema.secrets.id, row.secretId));
        await audit(tx, ctx, "vector_store.deleted", id, { provider: row.provider });
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new HttpError(
          409,
          "in_use",
          "A knowledge base uses this vector store. Delete the knowledge base first.",
        );
      }
      throw err;
    }
    return reply.code(204).send();
  });
}
