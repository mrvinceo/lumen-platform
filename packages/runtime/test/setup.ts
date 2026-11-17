import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalKeyProvider } from "@lumen/crypto";
import { createDb, type DbHandle, schema, withSystem, withTenant } from "@lumen/db";
import { runMigrations } from "@lumen/db/migrate";
import { ensureManagedStore, fsObjectStore, objectKey, type RuntimeDeps, storeSecret } from "../src/index.js";

export const DIM = 768;
export const EMBED_BASE = "http://embed.test/v1";
export const EMBED_KEY = "sk-embed-test-0123456789";

/** Bag-of-words hashing embedder: texts sharing words get similar vectors, so search results are meaningful. */
export function wordVector(text: string, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 3) continue;
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[Math.abs(h) % dim]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export interface StubEmbedder {
  fetch: typeof fetch;
  calls: { inputs: string[] }[];
  failWith?: number;
}

export function stubEmbedder(): StubEmbedder {
  const stub: StubEmbedder = {
    calls: [],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const json = (b: unknown, s = 200) =>
        new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
      if (stub.failWith) return json({ error: { message: "Invalid API key" } }, stub.failWith);
      if (req.headers.get("authorization") !== `Bearer ${EMBED_KEY}`)
        return json({ error: { message: "bad key" } }, 401);
      const body = (await req.json()) as { input: string[] };
      stub.calls.push({ inputs: body.input });
      return json({
        object: "list",
        data: body.input.map((t, index) => ({ object: "embedding", index, embedding: wordVector(t) })),
        model: "stub",
        usage: { prompt_tokens: body.input.length * 10, total_tokens: body.input.length * 10 },
      });
    }) as typeof fetch,
  };
  return stub;
}

export interface World {
  handle: DbHandle;
  deps: RuntimeDeps;
  embedder: StubEmbedder;
  close(): Promise<void>;
}

export async function makeWorld(): Promise<World> {
  const url = process.env.DATABASE_URL!;
  await runMigrations(process.env.DATABASE_ADMIN_URL || url);
  const handle = createDb(url);
  const embedder = stubEmbedder();
  const deps: RuntimeDeps = {
    db: handle.db,
    keys: new LocalKeyProvider(randomBytes(32).toString("base64")),
    objects: fsObjectStore(mkdtempSync(join(tmpdir(), "lumen-objects-"))),
    fetch: embedder.fetch,
  };
  return { handle, deps, embedder, close: () => handle.close() };
}

/** A tenant with an embedding model (stub), the managed store, one KB and its upload source. */
export async function makeTenantKb(world: World) {
  const { db } = world.deps;
  const suffix = randomUUID().slice(0, 8);
  const tenantId = await withSystem(db, async (sys) => {
    const [t] = await sys
      .insert(schema.tenants)
      .values({ name: `T ${suffix}`, slug: `t-${suffix}` })
      .returning();
    return t!.id;
  });
  return withTenant(db, tenantId, async (tx) => {
    const secret = await storeSecret(tx, world.deps.keys, {
      tenantId,
      kind: "embedding_api_key",
      label: "k",
      value: EMBED_KEY,
    });
    const [emb] = await tx
      .insert(schema.providerConfigs)
      .values({
        tenantId,
        type: "embedding",
        provider: "openai_compatible",
        model: "stub",
        label: "stub",
        secretId: secret.id,
        baseUrl: EMBED_BASE,
        options: { dimension: DIM },
      })
      .returning();
    const store = await ensureManagedStore(tx, tenantId);
    const kbId = randomUUID();
    const [kb] = await tx
      .insert(schema.knowledgeBases)
      .values({
        id: kbId,
        tenantId,
        name: "KB",
        embeddingConfigId: emb!.id,
        vectorStoreId: store.id,
        dimension: DIM,
        namespace: `kb_${kbId}`,
      })
      .returning();
    const [source] = await tx
      .insert(schema.sources)
      .values({ tenantId, kbId, type: "upload", name: "Uploads" })
      .returning();
    return { tenantId, kb: kb!, sourceId: source!.id, embeddingConfigId: emb!.id };
  });
}

/** Stores a file and creates its document row, as the upload API does. */
export async function addDocument(
  world: World,
  t: { tenantId: string; kb: { id: string }; sourceId: string },
  filename: string,
  content: string | Uint8Array,
  audience: "public" | "staff" = "public",
) {
  const documentId = randomUUID();
  const key = objectKey(t.tenantId, t.kb.id, documentId, filename);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  await world.deps.objects.put(key, bytes);
  await withTenant(world.deps.db, t.tenantId, (tx) =>
    tx.insert(schema.documents).values({
      id: documentId,
      tenantId: t.tenantId,
      kbId: t.kb.id,
      sourceId: t.sourceId,
      externalId: documentId,
      title: filename,
      storageKey: key,
      sizeBytes: bytes.byteLength,
      audience,
    }),
  );
  return documentId;
}
