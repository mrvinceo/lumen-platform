import { eq, schema, sql } from "@lumen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUpWithTenant, startTestServer, type TestServer } from "./helpers.js";

const BASE = "http://llm.test/v1";
const GOOD_KEY = "sk-good-0123456789abcdefghij";

/** Stub OpenAI-compatible server: accepts GOOD_KEY, serves model "llama3" and 768-dim embeddings. */
const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const auth = req.headers.get("authorization");
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (!req.url.startsWith(BASE)) return json({ error: "unexpected host" }, 500);
  if (auth !== `Bearer ${GOOD_KEY}`) return json({ error: { message: "Invalid API key" } }, 401);
  if (req.url.endsWith("/models"))
    return json({
      object: "list",
      data: [
        { id: "llama3", object: "model" },
        { id: "nomic-embed", object: "model" },
      ],
    });
  if (req.url.endsWith("/embeddings")) {
    return json({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: new Array(768).fill(0.01) }],
      model: "nomic-embed",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }
  return json({ error: "not found" }, 404);
}) as typeof fetch;

const llmDraft = {
  type: "llm",
  provider: "openai_compatible",
  model: "llama3",
  baseUrl: BASE,
  apiKey: GOOD_KEY,
};

describe.skipIf(!process.env.DATABASE_URL)("model provider API", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ fetch: stubFetch });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("requires sign-in", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(res.statusCode).toBe(401);
  });

  it("signs up, creates a workspace and reports it from /me", async () => {
    const { client, email, tenantId } = await signUpWithTenant(server.app, "alpha");
    const me = (await client.get("/api/v1/me")).json() as {
      user: { email: string };
      tenant: { id: string; role: string };
    };
    expect(me.user.email).toBe(email);
    expect(me.tenant).toMatchObject({ id: tenantId, role: "owner" });
  });

  it("tests a draft without saving it", async () => {
    const { client } = await signUpWithTenant(server.app, "drafter");
    const ok = await client.post("/api/v1/providers/test", llmDraft);
    expect(ok.json()).toMatchObject({ result: { ok: true } });
    const bad = await client.post("/api/v1/providers/test", {
      ...llmDraft,
      apiKey: "sk-wrong-0123456789abcdef",
    });
    expect(bad.json()).toMatchObject({ result: { ok: false, code: "auth" } });
    expect((await client.get("/api/v1/providers")).json()).toEqual({ providers: [] });
  });

  it("saves a verified provider, encrypts the key and never returns it", async () => {
    const { client, tenantId } = await signUpWithTenant(server.app, "saver");
    const res = await client.post("/api/v1/providers", { ...llmDraft, label: "Local Llama" });
    expect(res.status).toBe(201);
    const created = (res.json() as { provider: Record<string, unknown> }).provider;
    expect(created).toMatchObject({
      label: "Local Llama",
      hasKey: true,
      keyHint: "…ghij",
      provider: "openai_compatible",
    });
    expect(JSON.stringify(created)).not.toContain(GOOD_KEY);

    const list = await client.get("/api/v1/providers");
    expect(list.body).not.toContain(GOOD_KEY);
    expect((list.json() as { providers: unknown[] }).providers).toHaveLength(1);

    const [stored] = await server.handle.db
      .select()
      .from(schema.secrets)
      .where(eq(schema.secrets.tenantId, tenantId));
    expect(stored?.ciphertext).toBeDefined();
    expect(stored?.ciphertext).not.toContain(GOOD_KEY);

    const tested = await client.post(`/api/v1/providers/${created.id}/test`);
    expect(tested.json()).toMatchObject({ result: { ok: true } });

    const audit = await server.handle.db.execute<{ action: string }>(
      sql`select action from audit_log where tenant_id = ${tenantId}`,
    );
    expect(audit.map((a) => a.action)).toContain("provider.created");
  });

  it("refuses to save a configuration that fails its connection test", async () => {
    const { client } = await signUpWithTenant(server.app, "failer");
    const res = await client.post("/api/v1/providers", { ...llmDraft, apiKey: "sk-wrong-0123456789abcdef" });
    expect(res.status).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "connection_failed", details: { code: "auth" } } });
  });

  it("validates embedding dimensions and verifies them live", async () => {
    const { client } = await signUpWithTenant(server.app, "embedder");
    const base = {
      type: "embedding",
      provider: "openai_compatible",
      model: "nomic-embed",
      baseUrl: BASE,
      apiKey: GOOD_KEY,
    };
    expect((await client.post("/api/v1/providers", { ...base, dimension: 512 })).status).toBe(400);
    expect((await client.post("/api/v1/providers", { ...base, dimension: 1536 })).status).toBe(422);
    const ok = await client.post("/api/v1/providers", { ...base, dimension: 768 });
    expect(ok.status).toBe(201);
    expect(ok.json()).toMatchObject({ provider: { dimension: 768, type: "embedding" } });
  });

  it("rejects provider/kind mismatches", async () => {
    const { client } = await signUpWithTenant(server.app, "mismatch");
    const res = await client.post("/api/v1/providers", {
      type: "embedding",
      provider: "anthropic",
      model: "x",
      apiKey: "k-0123456789",
      dimension: 768,
    });
    expect(res.json()).toMatchObject({ error: { code: "unsupported_kind" } });
  });

  it("rotates a key and removes the old secret", async () => {
    const { client, tenantId } = await signUpWithTenant(server.app, "rotator");
    const created = (
      (await client.post("/api/v1/providers", llmDraft)).json() as { provider: { id: string } }
    ).provider;
    const before = await server.handle.db
      .select()
      .from(schema.secrets)
      .where(eq(schema.secrets.tenantId, tenantId));
    const patched = await client.patch(`/api/v1/providers/${created.id}`, {
      apiKey: GOOD_KEY,
      label: "Renamed",
    });
    expect(patched.json()).toMatchObject({ provider: { label: "Renamed", hasKey: true } });
    const after = await server.handle.db
      .select()
      .from(schema.secrets)
      .where(eq(schema.secrets.tenantId, tenantId));
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });

  it("keeps tenants apart", async () => {
    const a = await signUpWithTenant(server.app, "tenant-a");
    const b = await signUpWithTenant(server.app, "tenant-b");
    const created = (
      (await a.client.post("/api/v1/providers", llmDraft)).json() as { provider: { id: string } }
    ).provider;

    expect((await b.client.get("/api/v1/providers")).json()).toEqual({ providers: [] });
    expect((await b.client.post(`/api/v1/providers/${created.id}/test`)).status).toBe(404);
    expect((await b.client.patch(`/api/v1/providers/${created.id}`, { label: "pwned" })).status).toBe(404);
    expect((await b.client.delete(`/api/v1/providers/${created.id}`)).status).toBe(404);
    expect(
      (
        await b.client.post("/api/v1/providers/models", {
          provider: "openai_compatible",
          providerConfigId: created.id,
        })
      ).status,
    ).toBe(404);
    // Still intact for its owner.
    expect(
      ((await a.client.get("/api/v1/providers")).json() as { providers: unknown[] }).providers,
    ).toHaveLength(1);
  });

  it("enforces roles: viewers can read but not change providers", async () => {
    const { client, tenantId } = await signUpWithTenant(server.app, "roles");
    const created = (
      (await client.post("/api/v1/providers", llmDraft)).json() as { provider: { id: string } }
    ).provider;
    await server.handle.db
      .update(schema.members)
      .set({ role: "viewer" })
      .where(eq(schema.members.tenantId, tenantId));

    expect((await client.get("/api/v1/providers")).status).toBe(200);
    expect((await client.post("/api/v1/providers", llmDraft)).status).toBe(403);
    expect((await client.delete(`/api/v1/providers/${created.id}`)).status).toBe(403);
    expect((await client.post(`/api/v1/providers/${created.id}/test`)).status).toBe(403);
  });

  it("deletes a provider and its secret", async () => {
    const { client, tenantId } = await signUpWithTenant(server.app, "deleter");
    const created = (
      (await client.post("/api/v1/providers", llmDraft)).json() as { provider: { id: string } }
    ).provider;
    expect((await client.delete(`/api/v1/providers/${created.id}`)).status).toBe(204);
    expect(
      await server.handle.db.select().from(schema.secrets).where(eq(schema.secrets.tenantId, tenantId)),
    ).toHaveLength(0);
  });

  it("lists live models using a stored key", async () => {
    const { client } = await signUpWithTenant(server.app, "lister");
    const created = (
      (await client.post("/api/v1/providers", llmDraft)).json() as { provider: { id: string } }
    ).provider;
    const res = await client.post("/api/v1/providers/models", {
      provider: "openai_compatible",
      providerConfigId: created.id,
    });
    expect(res.json()).toEqual({ models: ["llama3", "nomic-embed"] });
  });

  it("serves the provider catalog", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/v1/catalog" });
    const body = res.json() as { providers: { id: string }[]; dimensions: number[] };
    expect(body.providers.map((p) => p.id)).toContain("anthropic");
    expect(body.dimensions).toEqual([768, 1024, 1536, 3072]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("SaaS mode", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ fetch: stubFetch, mode: "saas" });
  });
  afterAll(async () => {
    await server?.close();
  });

  it.each([
    "http://llm.test/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest",
    "https://10.0.0.5/v1",
    "https://localhost/v1",
  ])("refuses base URL %s", async (baseUrl) => {
    const { client } = await signUpWithTenant(server.app, "saas");
    const res = await client.post("/api/v1/providers/test", { ...llmDraft, baseUrl });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_base_url" } });
  });
});
