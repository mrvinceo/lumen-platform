import { expect } from "vitest";
import type { Client } from "./helpers.js";

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
export const chat = { status: 200 };
export const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
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
    if (chat.status !== 200) return json({ error: { message: "nope" } }, chat.status);
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

export const POLICY =
  "# Shipping\n\nExpress delivery arrives the next working day.\n\n## Returns\n\nUnused items can be returned within 30 days.\n";

// biome-ignore lint/suspicious/noExplicitAny: test helper reads arbitrary event fields
export type SseEvent = { type: string } & Record<string, any>;
export const parseSse = (body: string): SseEvent[] =>
  body
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(6)) as SseEvent);

export async function setupBot(client: Client) {
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
