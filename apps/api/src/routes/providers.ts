import {
  isProviderId,
  isSupportedDimension,
  listModels,
  type ModelKind,
  PROVIDER_IDS,
  PROVIDERS,
  type ProviderId,
  SUPPORTED_DIMENSIONS,
  supportsKind,
  testModel,
} from "@lumen/core";
import type { KeyProvider } from "@lumen/crypto";
import { maskSecret } from "@lumen/crypto";
import { and, type Database, desc, eq, schema, type Tx, withTenant } from "@lumen/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../auth.js";
import { assertSafeBaseUrl } from "../lib/baseUrl.js";
import { HttpError, notFound } from "../lib/errors.js";
import { readSecret, storeSecret } from "../lib/secrets.js";
import { type RequestContext, requireRole, requireTenant } from "../lib/tenantContext.js";
import { parse } from "../lib/validate.js";

export interface ProviderRouteDeps {
  db: Database;
  auth: Auth;
  keys: KeyProvider;
  mode: "saas" | "selfhost";
  /** Injected in tests to stub provider HTTP calls. */
  fetch?: typeof fetch;
}

const kindSchema = z.enum(["llm", "embedding"]);
const providerSchema = z.enum(PROVIDER_IDS);

const draftSchema = z.object({
  type: kindSchema,
  provider: providerSchema,
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(1).max(4000).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  dimension: z.number().int().optional(),
});

const createSchema = draftSchema.extend({
  label: z.string().trim().min(1).max(100).optional(),
  /** Run a live connection test before saving (default). Saving is refused if it fails. */
  verify: z.boolean().default(true),
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  apiKey: z.string().trim().min(1).max(4000).optional(),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  dimension: z.number().int().optional(),
  verify: z.boolean().default(true),
});

const listModelsSchema = z.object({
  provider: providerSchema,
  apiKey: z.string().trim().min(1).max(4000).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  /** Use the key stored on an existing configuration instead of a new one. */
  providerConfigId: z.uuid().optional(),
});

type ProviderRow = typeof schema.providerConfigs.$inferSelect & { last4: string | null };

function present(row: ProviderRow) {
  const options = row.options as { dimension?: number };
  return {
    id: row.id,
    type: row.type,
    provider: row.provider,
    providerName: isProviderId(row.provider) ? PROVIDERS[row.provider].name : row.provider,
    model: row.model,
    label: row.label,
    baseUrl: row.baseUrl,
    dimension: options.dimension ?? null,
    hasKey: row.secretId !== null,
    keyHint: row.secretId ? maskSecret(row.last4 ?? "") : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadRow(tx: Tx, tenantId: string, id: string): Promise<ProviderRow> {
  const [row] = await tx
    .select({ config: schema.providerConfigs, last4: schema.secrets.last4 })
    .from(schema.providerConfigs)
    .leftJoin(schema.secrets, eq(schema.secrets.id, schema.providerConfigs.secretId))
    .where(and(eq(schema.providerConfigs.id, id), eq(schema.providerConfigs.tenantId, tenantId)));
  if (!row) throw notFound("Model provider");
  return { ...row.config, last4: row.last4 };
}

async function audit(
  tx: Tx,
  ctx: RequestContext,
  action: string,
  target: string,
  metadata?: Record<string, unknown>,
) {
  await tx
    .insert(schema.auditLog)
    .values({ tenantId: ctx.tenantId, actorId: ctx.userId, action, target, metadata });
}

export async function providerRoutes(app: FastifyInstance, deps: ProviderRouteDeps): Promise<void> {
  const { db, auth, keys } = deps;
  const ctxOf = (req: Parameters<typeof requireTenant>[2]) => requireTenant(auth, db, req);

  /** Checks a draft is internally consistent and normalises the base URL. */
  async function validateDraft(d: z.infer<typeof draftSchema>, requireKey: boolean) {
    const info = PROVIDERS[d.provider as ProviderId];
    if (!supportsKind(d.provider, d.type)) {
      throw new HttpError(
        400,
        "unsupported_kind",
        `${info.name} does not provide ${d.type === "llm" ? "chat" : "embedding"} models.`,
      );
    }
    let baseUrl: string | undefined;
    if (info.baseUrl === "required" && !d.baseUrl)
      throw new HttpError(400, "base_url_required", "A base URL is required.");
    if (info.baseUrl === "none" && d.baseUrl)
      throw new HttpError(400, "base_url_not_allowed", `${info.name} does not take a base URL.`);
    if (d.baseUrl) baseUrl = await assertSafeBaseUrl(d.baseUrl, deps.mode);
    if (requireKey && info.keyRequired && !d.apiKey)
      throw new HttpError(400, "api_key_required", "An API key is required.");
    if (d.type === "embedding") {
      if (!d.dimension || !isSupportedDimension(d.dimension)) {
        throw new HttpError(
          400,
          "invalid_dimension",
          `Embedding dimension must be one of ${SUPPORTED_DIMENSIONS.join(", ")}.`,
        );
      }
    } else if (d.dimension !== undefined) {
      throw new HttpError(400, "invalid_dimension", "Only embedding models take a dimension.");
    }
    return { baseUrl };
  }

  const runTest = (
    kind: ModelKind,
    d: { provider: ProviderId; model: string; apiKey?: string; baseUrl?: string; dimension?: number },
  ) => testModel(kind, { ...d, fetch: deps.fetch });

  app.get("/api/v1/catalog", async () => ({
    providers: Object.values(PROVIDERS),
    dimensions: SUPPORTED_DIMENSIONS,
  }));

  app.get("/api/v1/providers", async (req) => {
    const ctx = await ctxOf(req);
    const q = parse(z.object({ type: kindSchema.optional() }), req.query);
    const rows = await withTenant(db, ctx.tenantId, (tx) =>
      tx
        .select({ config: schema.providerConfigs, last4: schema.secrets.last4 })
        .from(schema.providerConfigs)
        .leftJoin(schema.secrets, eq(schema.secrets.id, schema.providerConfigs.secretId))
        .where(q.type ? eq(schema.providerConfigs.type, q.type) : undefined)
        .orderBy(desc(schema.providerConfigs.createdAt)),
    );
    return { providers: rows.map((r) => present({ ...r.config, last4: r.last4 })) };
  });

  /** Test a configuration before saving it (onboarding wizard). Nothing is stored. */
  app.post("/api/v1/providers/test", async (req) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const d = parse(draftSchema, req.body);
    const { baseUrl } = await validateDraft(d, true);
    return { result: await runTest(d.type, { ...d, baseUrl }) };
  });

  /** Live model list from the provider, so tenants can pick models released after this build. */
  app.post("/api/v1/providers/models", async (req) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const body = parse(listModelsSchema, req.body);
    let apiKey = body.apiKey;
    let baseUrl = body.baseUrl ? await assertSafeBaseUrl(body.baseUrl, deps.mode) : undefined;
    if (body.providerConfigId) {
      const id = body.providerConfigId;
      const stored = await withTenant(db, ctx.tenantId, async (tx) => {
        const row = await loadRow(tx, ctx.tenantId, id);
        return {
          row,
          key: row.secretId ? await readSecret(tx, keys, ctx.tenantId, row.secretId) : undefined,
        };
      });
      if (stored.row.provider !== body.provider)
        throw new HttpError(400, "provider_mismatch", "That configuration uses a different provider.");
      apiKey ??= stored.key;
      baseUrl ??= stored.row.baseUrl ?? undefined;
    }
    try {
      return { models: await listModels({ provider: body.provider, apiKey, baseUrl, fetch: deps.fetch }) };
    } catch (err) {
      const pe = err as { code?: string; message?: string };
      throw new HttpError(502, `provider_${pe.code ?? "error"}`, pe.message ?? "Could not list models.");
    }
  });

  app.post("/api/v1/providers", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const d = parse(createSchema, req.body);
    const { baseUrl } = await validateDraft(d, true);
    if (d.verify) {
      const result = await runTest(d.type, { ...d, baseUrl });
      if (!result.ok) throw new HttpError(422, "connection_failed", result.message, result);
    }
    const label = d.label ?? `${PROVIDERS[d.provider].name} · ${d.model}`;
    const row = await withTenant(db, ctx.tenantId, async (tx) => {
      const secret = d.apiKey
        ? await storeSecret(tx, keys, {
            tenantId: ctx.tenantId,
            kind: d.type === "llm" ? "llm_api_key" : "embedding_api_key",
            label: `${label} API key`,
            value: d.apiKey,
          })
        : undefined;
      const [created] = await tx
        .insert(schema.providerConfigs)
        .values({
          tenantId: ctx.tenantId,
          type: d.type,
          provider: d.provider,
          model: d.model,
          label,
          secretId: secret?.id,
          baseUrl,
          options: d.type === "embedding" ? { dimension: d.dimension } : {},
        })
        .returning();
      if (!created) throw new Error("insert returned no row");
      await audit(tx, ctx, "provider.created", created.id, {
        provider: d.provider,
        model: d.model,
        type: d.type,
      });
      return { ...created, last4: secret?.last4 ?? null };
    });
    return reply.code(201).send({ provider: present(row) });
  });

  app.patch<{ Params: { id: string } }>("/api/v1/providers/:id", async (req) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const id = parse(z.uuid(), req.params.id);
    const patch = parse(updateSchema, req.body);

    const current = await withTenant(db, ctx.tenantId, async (tx) => {
      const row = await loadRow(tx, ctx.tenantId, id);
      return { row, key: row.secretId ? await readSecret(tx, keys, ctx.tenantId, row.secretId) : undefined };
    });
    const provider = current.row.provider as ProviderId;
    const kind = current.row.type as ModelKind;
    const draft = {
      type: kind,
      provider,
      model: patch.model ?? current.row.model,
      apiKey: patch.apiKey ?? current.key,
      baseUrl: patch.baseUrl === null ? undefined : (patch.baseUrl ?? current.row.baseUrl ?? undefined),
      dimension:
        kind === "embedding"
          ? (patch.dimension ?? (current.row.options as { dimension?: number }).dimension)
          : undefined,
    };
    const { baseUrl } = await validateDraft(draft, true);
    if (patch.verify) {
      const result = await runTest(kind, { ...draft, baseUrl });
      if (!result.ok) throw new HttpError(422, "connection_failed", result.message, result);
    }

    const row = await withTenant(db, ctx.tenantId, async (tx) => {
      let secretId = current.row.secretId;
      let last4 = current.row.last4;
      if (patch.apiKey) {
        const secret = await storeSecret(tx, keys, {
          tenantId: ctx.tenantId,
          kind: kind === "llm" ? "llm_api_key" : "embedding_api_key",
          label: `${patch.label ?? current.row.label} API key`,
          value: patch.apiKey,
        });
        secretId = secret.id;
        last4 = secret.last4;
      }
      const [updated] = await tx
        .update(schema.providerConfigs)
        .set({
          label: patch.label ?? current.row.label,
          model: draft.model,
          baseUrl: baseUrl ?? null,
          secretId,
          options: kind === "embedding" ? { dimension: draft.dimension } : {},
        })
        .where(and(eq(schema.providerConfigs.id, id), eq(schema.providerConfigs.tenantId, ctx.tenantId)))
        .returning();
      if (patch.apiKey && current.row.secretId) {
        await tx.delete(schema.secrets).where(eq(schema.secrets.id, current.row.secretId));
      }
      await audit(tx, ctx, "provider.updated", id, { keyRotated: Boolean(patch.apiKey) });
      if (!updated) throw notFound("Model provider");
      return { ...updated, last4 };
    });
    return { provider: present(row) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/providers/:id", async (req, reply) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "admin");
    const id = parse(z.uuid(), req.params.id);
    try {
      await withTenant(db, ctx.tenantId, async (tx) => {
        const row = await loadRow(tx, ctx.tenantId, id);
        await tx.delete(schema.providerConfigs).where(eq(schema.providerConfigs.id, id));
        if (row.secretId) await tx.delete(schema.secrets).where(eq(schema.secrets.id, row.secretId));
        await audit(tx, ctx, "provider.deleted", id, { provider: row.provider, model: row.model });
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new HttpError(
          409,
          "in_use",
          "This model is used by a knowledge base or bot. Remove it there first.",
        );
      }
      throw err;
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/v1/providers/:id/test", async (req) => {
    const ctx = await ctxOf(req);
    requireRole(ctx, "editor");
    const id = parse(z.uuid(), req.params.id);
    const { row, key } = await withTenant(db, ctx.tenantId, async (tx) => {
      const r = await loadRow(tx, ctx.tenantId, id);
      return { row: r, key: r.secretId ? await readSecret(tx, keys, ctx.tenantId, r.secretId) : undefined };
    });
    if (!isProviderId(row.provider)) throw new HttpError(400, "unknown_provider", "Unknown provider.");
    const result = await runTest(row.type as ModelKind, {
      provider: row.provider,
      model: row.model,
      apiKey: key,
      baseUrl: row.baseUrl ?? undefined,
      dimension: (row.options as { dimension?: number }).dimension,
    });
    return { result };
  });
}

function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23503" || e?.cause?.code === "23503";
}
