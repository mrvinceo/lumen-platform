import { eq, schema, sql } from "@lumen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, signUpWithTenant, startTestServer, type TestServer } from "./helpers.js";

const BASE = "http://embed.test/v1";
const KEY = "sk-embed-0123456789abcdef";

/** Word-hashing embeddings: texts sharing words are close, so search results are meaningful. */
function wordVector(text: string, dim: number): number[] {
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

let failEmbeddings = false;
const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (req.headers.get("authorization") !== `Bearer ${KEY}` || failEmbeddings)
    return json({ error: { message: "Invalid API key" } }, 401);
  if (req.url.endsWith("/embeddings")) {
    const body = (await req.json()) as { input: string[] };
    return json({
      object: "list",
      data: body.input.map((t, index) => ({ object: "embedding", index, embedding: wordVector(t, 768) })),
      model: "stub",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });
  }
  return json({ error: "nf" }, 404);
}) as typeof fetch;

const POLICY =
  "# Returns\n\nUnused items can be returned within 30 days.\n\n## Shipping\n\nExpress delivery arrives the next working day.\n";

async function setupKb(client: Client) {
  const emb = await client.post("/api/v1/providers", {
    type: "embedding",
    provider: "openai_compatible",
    model: "stub",
    baseUrl: BASE,
    apiKey: KEY,
    dimension: 768,
  });
  const embeddingConfigId = (emb.json() as { provider: { id: string } }).provider.id;
  const kb = await client.post("/api/v1/knowledge-bases", { name: "Help centre", embeddingConfigId });
  expect(kb.status).toBe(201);
  return { kbId: (kb.json() as { knowledgeBase: { id: string } }).knowledgeBase.id, embeddingConfigId };
}

describe.skipIf(!process.env.DATABASE_URL)("knowledge base API", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ fetch: stubFetch });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("lists the built-in managed vector store", async () => {
    const { client } = await signUpWithTenant(server.app, "stores");
    const res = (await client.get("/api/v1/vector-stores")).json() as {
      vectorStores: { provider: string; managed: boolean }[];
    };
    expect(res.vectorStores).toEqual([
      expect.objectContaining({ provider: "pgvector_managed", managed: true }),
    ]);
    // Idempotent: asking again doesn't create a second one.
    expect(
      ((await client.get("/api/v1/vector-stores")).json() as { vectorStores: unknown[] }).vectorStores,
    ).toHaveLength(1);
  });

  it("creates a knowledge base on the managed store, uploads, indexes and searches", async () => {
    const { client } = await signUpWithTenant(server.app, "kb");
    const { kbId } = await setupKb(client);

    const up = await client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
      { name: "policy.md", content: POLICY },
      { name: "notes.txt", content: "Our office is open nine to five on weekdays." },
    ]);
    expect(up.status).toBe(201);
    expect((up.json() as { documents: unknown[] }).documents).toHaveLength(2);

    const docs = (await client.get(`/api/v1/knowledge-bases/${kbId}/documents`)).json() as {
      documents: { title: string; status: string; chunkCount: number }[];
    };
    expect(docs.documents.map((d) => d.status)).toEqual(["indexed", "indexed"]);

    const kb = (await client.get(`/api/v1/knowledge-bases/${kbId}`)).json() as {
      knowledgeBase: Record<string, unknown>;
    };
    expect(kb.knowledgeBase).toMatchObject({
      documentCount: 2,
      indexedCount: 2,
      dimension: 768,
      vectorStoreProvider: "pgvector_managed",
    });

    const search = await client.post(`/api/v1/knowledge-bases/${kbId}/search`, {
      query: "when does express delivery arrive",
    });
    const hits = (
      search.json() as { hits: { documentTitle: string; headings: string[]; text: string; score: number }[] }
    ).hits;
    expect(hits[0]).toMatchObject({ documentTitle: "policy.md", headings: ["Returns", "Shipping"] });
    expect(hits[0]!.score).toBeGreaterThan(hits.at(-1)!.score - 1e-9);
  });

  it("rejects unsupported and oversized files but keeps the rest", async () => {
    const { client } = await signUpWithTenant(server.app, "rejects");
    const { kbId } = await setupKb(client);
    const res = await client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
      { name: "ok.md", content: "# Fine\n\nThis is fine." },
      { name: "fake.pdf", content: "not really a pdf" },
      { name: "binary.bin", content: new Uint8Array([0, 1, 2, 0, 3]) },
      { name: "huge.txt", content: "a".repeat(1024 * 1024 + 10) },
    ]);
    expect(res.status).toBe(201);
    const body = res.json() as {
      documents: { title: string }[];
      rejected: { filename: string; reason: string }[];
    };
    expect(body.documents.map((d) => d.title)).toEqual(["ok.md"]);
    expect(body.rejected.map((r) => r.filename).sort()).toEqual(["binary.bin", "fake.pdf", "huge.txt"]);
  });

  it("keeps staff documents out of public-only searches", async () => {
    const { client } = await signUpWithTenant(server.app, "audience");
    const { kbId } = await setupKb(client);
    await client.upload(
      `/api/v1/knowledge-bases/${kbId}/documents`,
      [{ name: "pay.md", content: "# Pay\n\nSenior engineers earn band seven." }],
      "staff",
    );
    const pub = await client.post(`/api/v1/knowledge-bases/${kbId}/search`, {
      query: "senior engineers band",
      audiences: ["public"],
    });
    expect((pub.json() as { hits: unknown[] }).hits).toEqual([]);
    const all = await client.post(`/api/v1/knowledge-bases/${kbId}/search`, {
      query: "senior engineers band",
    });
    expect((all.json() as { hits: { audience: string }[] }).hits[0]?.audience).toBe("staff");
  });

  it("shows embedding failures on the document, and re-indexes on request", async () => {
    const { client } = await signUpWithTenant(server.app, "errors");
    const { kbId } = await setupKb(client);
    failEmbeddings = true;
    try {
      await client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
        { name: "policy.md", content: POLICY },
      ]);
    } finally {
      failEmbeddings = false;
    }
    const docs = (await client.get(`/api/v1/knowledge-bases/${kbId}/documents`)).json() as {
      documents: { id: string; status: string; error: string }[];
    };
    expect(docs.documents[0]).toMatchObject({ status: "error" });
    expect(docs.documents[0]!.error).toMatch(/API key was rejected/);

    const re = await client.post(
      `/api/v1/knowledge-bases/${kbId}/documents/${docs.documents[0]!.id}/reindex`,
    );
    expect(re.status).toBe(200);
    const after = (await client.get(`/api/v1/knowledge-bases/${kbId}/documents`)).json() as {
      documents: { status: string }[];
    };
    expect(after.documents[0]?.status).toBe("indexed");
  });

  it("deletes documents and knowledge bases", async () => {
    const { client, tenantId } = await signUpWithTenant(server.app, "deleter");
    const { kbId } = await setupKb(client);
    const up = (
      await client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
        { name: "policy.md", content: POLICY },
      ])
    ).json() as {
      documents: { id: string }[];
    };
    expect(
      (await client.delete(`/api/v1/knowledge-bases/${kbId}/documents/${up.documents[0]!.id}`)).status,
    ).toBe(204);
    const s = await client.post(`/api/v1/knowledge-bases/${kbId}/search`, { query: "express delivery" });
    expect((s.json() as { hits: unknown[] }).hits).toEqual([]);

    expect((await client.delete(`/api/v1/knowledge-bases/${kbId}`)).status).toBe(202);
    expect((await client.get(`/api/v1/knowledge-bases/${kbId}`)).status).toBe(404);
    const rows = await server.handle.db
      .select()
      .from(schema.knowledgeBases)
      .where(eq(schema.knowledgeBases.tenantId, tenantId));
    expect(rows).toHaveLength(0);
  });

  it("refuses to change a knowledge base's embedding model", async () => {
    const { client } = await signUpWithTenant(server.app, "locked");
    const { kbId } = await setupKb(client);
    const other = await client.post("/api/v1/providers", {
      type: "embedding",
      provider: "openai_compatible",
      model: "stub-2",
      baseUrl: BASE,
      apiKey: KEY,
      dimension: 768,
    });
    const otherId = (other.json() as { provider: { id: string } }).provider.id;
    const res = await client.patch(`/api/v1/knowledge-bases/${kbId}`, { embeddingConfigId: otherId });
    expect(res.json()).toMatchObject({ error: { code: "embedding_model_locked" } });
    // And the model in use can't be deleted from under the knowledge base.
    const { embeddingConfigId } = {
      embeddingConfigId: (
        (await client.get(`/api/v1/knowledge-bases/${kbId}`)).json() as {
          knowledgeBase: { embeddingConfigId: string };
        }
      ).knowledgeBase.embeddingConfigId,
    };
    expect((await client.delete(`/api/v1/providers/${embeddingConfigId}`)).status).toBe(409);
  });

  it("keeps tenants apart across every knowledge route", async () => {
    const a = await signUpWithTenant(server.app, "kb-a");
    const b = await signUpWithTenant(server.app, "kb-b");
    const { kbId } = await setupKb(a.client);
    const up = (
      await a.client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
        { name: "policy.md", content: POLICY },
      ])
    ).json() as {
      documents: { id: string }[];
    };
    const docId = up.documents[0]!.id;
    const base = `/api/v1/knowledge-bases/${kbId}`;
    expect(
      ((await b.client.get("/api/v1/knowledge-bases")).json() as { knowledgeBases: unknown[] })
        .knowledgeBases,
    ).toEqual([]);
    expect((await b.client.get(base)).status).toBe(404);
    expect((await b.client.get(`${base}/documents`)).status).toBe(404);
    expect((await b.client.post(`${base}/search`, { query: "express" })).status).toBe(404);
    expect((await b.client.upload(`${base}/documents`, [{ name: "x.md", content: "# x\n\ny" }])).status).toBe(
      404,
    );
    expect((await b.client.post(`${base}/documents/${docId}/reindex`)).status).toBe(404);
    expect((await b.client.delete(`${base}/documents/${docId}`)).status).toBe(404);
    expect((await b.client.delete(base)).status).toBe(404);
    expect((await b.client.patch(base, { name: "pwned" })).status).toBe(404);
    // B can't build a KB on A's embedding model either.
    const aModels = (await a.client.get("/api/v1/providers")).json() as { providers: { id: string }[] };
    const steal = await b.client.post("/api/v1/knowledge-bases", {
      name: "x",
      embeddingConfigId: aModels.providers[0]!.id,
    });
    expect(steal.status).toBe(400);
    // A's document is still there and searchable.
    const s = await a.client.post(`${base}/search`, { query: "express delivery" });
    expect((s.json() as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
  });

  it("enforces roles", async () => {
    const { client, tenantId } = await signUpWithTenant(server.app, "kb-roles");
    const { kbId, embeddingConfigId } = await setupKb(client);
    await server.handle.db.execute(sql`update members set role = 'viewer' where tenant_id = ${tenantId}`);
    expect((await client.get(`/api/v1/knowledge-bases/${kbId}/documents`)).status).toBe(200);
    expect((await client.post(`/api/v1/knowledge-bases/${kbId}/search`, { query: "x" })).status).toBe(200);
    expect(
      (
        await client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
          { name: "a.md", content: "# a\n\nb" },
        ])
      ).status,
    ).toBe(403);
    expect((await client.post("/api/v1/knowledge-bases", { name: "x", embeddingConfigId })).status).toBe(403);
    await server.handle.db.execute(sql`update members set role = 'editor' where tenant_id = ${tenantId}`);
    expect(
      (
        await client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
          { name: "a.md", content: "# a\n\nb" },
        ])
      ).status,
    ).toBe(201);
    expect((await client.delete(`/api/v1/knowledge-bases/${kbId}`)).status).toBe(403);
  });

  it("validates new BYO vector stores before saving them", async () => {
    const { client } = await signUpWithTenant(server.app, "byo");
    const bad = await client.post("/api/v1/vector-stores", {
      provider: "firestore",
      serviceAccountJson: '{"type":"service_account"}',
    });
    expect(bad.json()).toMatchObject({ error: { code: "invalid_credentials" } });
    const badIndex = await client.post("/api/v1/vector-stores", {
      provider: "pinecone",
      apiKey: "pc-0123456789",
      indexName: "Bad_Name",
    });
    expect(badIndex.status).toBe(400);
    const managed = ((await client.get("/api/v1/vector-stores")).json() as { vectorStores: { id: string }[] })
      .vectorStores[0]!;
    expect((await client.delete(`/api/v1/vector-stores/${managed.id}`)).json()).toMatchObject({
      error: { code: "managed_store" },
    });
  });
});
