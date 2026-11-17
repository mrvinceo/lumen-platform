import { sql } from "@lumen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Client, signUpWithTenant, startTestServer, type TestServer } from "./helpers.js";

const BASE = "http://llm.test/v1";
const KEY = "sk-llm-0123456789abcdef";

function wordVector(text: string, dim = 768): number[] {
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

/** OpenAI-compatible stub: embeddings plus streamed chat that cites [1] when documents are present. */
let chatStatus = 200;
const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (req.headers.get("authorization") !== `Bearer ${KEY}`)
    return json({ error: { message: "Invalid API key" } }, 401);
  if (req.url.endsWith("/models"))
    return json({
      object: "list",
      data: [
        { id: "chat", object: "model" },
        { id: "embed", object: "model" },
      ],
    });
  if (req.url.endsWith("/embeddings")) {
    const body = (await req.json()) as { input: string[] };
    return json({
      object: "list",
      data: body.input.map((t, index) => ({ object: "embedding", index, embedding: wordVector(t) })),
      model: "embed",
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
  }
  if (req.url.endsWith("/chat/completions")) {
    if (chatStatus !== 200) return json({ error: { message: "nope" } }, chatStatus);
    const body = (await req.json()) as { messages: { role: string; content: string }[] };
    const system = body.messages[0]?.content ?? "";
    const reply = system.includes("<documents>")
      ? "Express delivery arrives the next working day [1]."
      : "No idea.";
    const frame = (o: object) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "chat", ...o })}\n\n`;
    const words = reply.match(/\S+\s*/g) ?? [];
    const sse =
      words
        .map((w) => frame({ choices: [{ index: 0, delta: { content: w }, finish_reason: null }] }))
        .join("") +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      frame({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 } }) +
      "data: [DONE]\n\n";
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  return json({ error: "nf" }, 404);
}) as typeof fetch;

const POLICY =
  "# Shipping\n\nExpress delivery arrives the next working day.\n\n## Returns\n\nUnused items can be returned within 30 days.\n";

// biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary event fields
type SseEvent = { type: string } & Record<string, any>;
const parseSse = (body: string): SseEvent[] =>
  body
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as SseEvent);

async function setupBot(client: Client) {
  const llm = await client.post("/api/v1/providers", {
    type: "llm",
    provider: "openai_compatible",
    model: "chat",
    baseUrl: BASE,
    apiKey: KEY,
  });
  const emb = await client.post("/api/v1/providers", {
    type: "embedding",
    provider: "openai_compatible",
    model: "embed",
    baseUrl: BASE,
    apiKey: KEY,
    dimension: 768,
  });
  const llmConfigId = (llm.json() as { provider: { id: string } }).provider.id;
  const embeddingConfigId = (emb.json() as { provider: { id: string } }).provider.id;
  const kb = await client.post("/api/v1/knowledge-bases", { name: "Help", embeddingConfigId });
  const kbId = (kb.json() as { knowledgeBase: { id: string } }).knowledgeBase.id;
  await client.upload(`/api/v1/knowledge-bases/${kbId}/documents`, [
    { name: "shipping.md", content: POLICY },
  ]);
  const bot = await client.post("/api/v1/bots", { name: "Support", kbIds: [kbId], llmConfigId });
  expect(bot.status).toBe(201);
  return { botId: (bot.json() as { bot: { id: string } }).bot.id, kbId, llmConfigId, embeddingConfigId };
}

describe.skipIf(!process.env.DATABASE_URL)("bots and chat API", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ fetch: stubFetch });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("creates a bot with sensible defaults and a public key", async () => {
    const { client } = await signUpWithTenant(server.app, "botdefaults");
    const { botId } = await setupBot(client);
    const bot = ((await client.get(`/api/v1/bots/${botId}`)).json() as { bot: Record<string, unknown> }).bot;
    expect(bot).toMatchObject({
      name: "Support",
      grounding: "strict",
      topK: 6,
      fallbackMessage: "I couldn't find that in our documentation.",
    });
    expect(bot.systemPrompt).toMatch(/You are the helpful assistant for botdefaults Inc/);
    expect(bot.publicKey).toMatch(/^pk_live_/);
    expect(bot.knowledgeBases).toEqual([expect.objectContaining({ name: "Help" })]);
  });

  it("streams a cited answer over SSE and stores the conversation", async () => {
    const { client } = await signUpWithTenant(server.app, "botchat");
    const { botId } = await setupBot(client);
    const res = await client.post(`/api/v1/bots/${botId}/chat`, {
      message: "When does express delivery arrive?",
    });
    expect(res.status).toBe(200);
    const events = parseSse(res.body);
    expect(events.map((e) => e.type)[0]).toBe("meta");
    expect(events.map((e) => e.type)[1]).toBe("sources");
    expect(events.at(-1)?.type).toBe("done");
    const answer = events
      .filter((e) => e.type === "delta")
      .map((e) => e.text)
      .join("");
    expect(answer).toBe("Express delivery arrives the next working day [1].");
    const done = events.at(-1) as unknown as { citations: { title: string }[]; messageId: string };
    expect(done.citations[0]?.title).toBe("shipping.md");

    const conversationId = (events[0] as unknown as { conversationId: string }).conversationId;
    const list = (await client.get(`/api/v1/bots/${botId}/conversations`)).json() as {
      conversations: { id: string; messageCount: number }[];
    };
    expect(list.conversations).toEqual([expect.objectContaining({ id: conversationId, messageCount: 2 })]);
    const transcript = (await client.get(`/api/v1/conversations/${conversationId}`)).json() as {
      messages: {
        role: string;
        content: string;
        citations: unknown[];
        retrieval: { sources: unknown[] } | null;
      }[];
    };
    expect(transcript.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(transcript.messages[1]?.citations).toHaveLength(1);
    expect(transcript.messages[1]?.retrieval?.sources.length).toBeGreaterThan(0);

    const fb = await client.post(`/api/v1/messages/${done.messageId}/feedback`, { feedback: "up" });
    expect(fb.json()).toMatchObject({ message: { feedback: "up" } });

    // Follow-up in the same conversation.
    const second = parseSse(
      (await client.post(`/api/v1/bots/${botId}/chat`, { message: "and returns?", conversationId })).body,
    );
    expect(second.at(-1)?.type).toBe("done");
  });

  it("reports model failures as an SSE error event", async () => {
    const { client } = await signUpWithTenant(server.app, "boterr");
    const { botId } = await setupBot(client);
    chatStatus = 500;
    try {
      const events = parseSse(
        (await client.post(`/api/v1/bots/${botId}/chat`, { message: "When does express delivery arrive?" }))
          .body,
      );
      expect(events.at(-1)).toMatchObject({ type: "error", code: "answer_failed" });
    } finally {
      chatStatus = 200;
    }
  });

  it("validates references and returns JSON errors before streaming", async () => {
    const a = await signUpWithTenant(server.app, "botval-a");
    const b = await signUpWithTenant(server.app, "botval-b");
    const refsA = await setupBot(a.client);
    const refsB = await setupBot(b.client);
    // B can't build a bot on A's knowledge base or model.
    expect(
      (
        await b.client.post("/api/v1/bots", {
          name: "x",
          kbIds: [refsA.kbId],
          llmConfigId: refsB.llmConfigId,
        })
      ).json(),
    ).toMatchObject({
      error: { code: "invalid_knowledge_base" },
    });
    expect(
      (await b.client.post("/api/v1/bots", { name: "x", kbIds: [], llmConfigId: refsA.llmConfigId })).status,
    ).toBe(400);
    // An embedding model is not a chat model.
    expect(
      (
        await a.client.post("/api/v1/bots", { name: "x", kbIds: [], llmConfigId: refsA.embeddingConfigId })
      ).json(),
    ).toMatchObject({
      error: { code: "invalid_chat_model" },
    });
    // Unknown conversation: a JSON 404, not a stream.
    const res = await a.client.post(`/api/v1/bots/${refsA.botId}/chat`, {
      message: "hi",
      conversationId: "00000000-0000-4000-8000-000000000000",
    });
    expect(res.status).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "conversation_not_found" } });
  });

  it("keeps tenants apart", async () => {
    const a = await signUpWithTenant(server.app, "botiso-a");
    const b = await signUpWithTenant(server.app, "botiso-b");
    const { botId } = await setupBot(a.client);
    const events = parseSse(
      (await a.client.post(`/api/v1/bots/${botId}/chat`, { message: "express delivery?" })).body,
    );
    const conversationId = (events[0] as unknown as { conversationId: string }).conversationId;
    const messageId = (events.at(-1) as unknown as { messageId: string }).messageId;

    expect(((await b.client.get("/api/v1/bots")).json() as { bots: unknown[] }).bots).toEqual([]);
    expect((await b.client.get(`/api/v1/bots/${botId}`)).status).toBe(404);
    expect((await b.client.post(`/api/v1/bots/${botId}/chat`, { message: "hi" })).status).toBe(404);
    expect((await b.client.get(`/api/v1/bots/${botId}/conversations`)).status).toBe(404);
    expect((await b.client.get(`/api/v1/conversations/${conversationId}`)).status).toBe(404);
    expect((await b.client.post(`/api/v1/messages/${messageId}/feedback`, { feedback: "down" })).status).toBe(
      404,
    );
    expect((await b.client.patch(`/api/v1/bots/${botId}`, { name: "pwned" })).status).toBe(404);
    expect((await b.client.delete(`/api/v1/bots/${botId}`)).status).toBe(404);
  });

  it("enforces roles", async () => {
    const { client, tenantId } = await signUpWithTenant(server.app, "botroles");
    const { botId, llmConfigId } = await setupBot(client);
    await server.handle.db.execute(sql`update members set role = 'viewer' where tenant_id = ${tenantId}`);
    expect((await client.get("/api/v1/bots")).status).toBe(200);
    expect((await client.get(`/api/v1/bots/${botId}/conversations`)).status).toBe(200);
    expect((await client.post(`/api/v1/bots/${botId}/chat`, { message: "hi" })).status).toBe(403);
    expect((await client.post("/api/v1/bots", { name: "x", kbIds: [], llmConfigId })).status).toBe(403);
    await server.handle.db.execute(sql`update members set role = 'editor' where tenant_id = ${tenantId}`);
    expect((await client.patch(`/api/v1/bots/${botId}`, { grounding: "lenient" })).json()).toMatchObject({
      bot: { grounding: "lenient" },
    });
    expect((await client.delete(`/api/v1/bots/${botId}`)).status).toBe(403);
  });

  it("removes a deleted knowledge base from its bots", async () => {
    const { client } = await signUpWithTenant(server.app, "botkbdel");
    const { botId, kbId } = await setupBot(client);
    expect((await client.delete(`/api/v1/knowledge-bases/${kbId}`)).status).toBe(202);
    const bot = ((await client.get(`/api/v1/bots/${botId}`)).json() as { bot: { kbIds: string[] } }).bot;
    expect(bot.kbIds).toEqual([]);
  });

  it("blocks deleting a chat model that a bot uses", async () => {
    const { client } = await signUpWithTenant(server.app, "botmodel");
    const { llmConfigId } = await setupBot(client);
    expect((await client.delete(`/api/v1/providers/${llmConfigId}`)).status).toBe(409);
  });
});
