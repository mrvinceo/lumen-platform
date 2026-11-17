import { describe, expect, it } from "vitest";
import { createChatModel, listModels, testModel } from "../src/index.js";
import { fakeFetch, json, sse } from "./fakeFetch.js";

const KEY = "sk-test-0123456789abcdefghij";

describe("OpenAI adapter", () => {
  it("tests a chat model via the models endpoint", async () => {
    const { fetch, calls } = fakeFetch([
      ["GET https://api.openai.com/v1/models/gpt-5-mini", () => json({ id: "gpt-5-mini", object: "model" })],
    ]);
    const res = await createChatModel({ provider: "openai", model: "gpt-5-mini", apiKey: KEY, fetch }).test();
    expect(res.ok).toBe(true);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("streams chat completions with usage", async () => {
    const { fetch, calls } = fakeFetch([
      [
        "POST https://api.openai.com/v1/chat/completions",
        () =>
          sse([
            {
              data: {
                id: "c",
                object: "chat.completion.chunk",
                created: 1,
                model: "gpt-5-mini",
                choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
              },
            },
            {
              data: {
                id: "c",
                object: "chat.completion.chunk",
                created: 1,
                model: "gpt-5-mini",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            },
            {
              data: {
                id: "c",
                object: "chat.completion.chunk",
                created: 1,
                model: "gpt-5-mini",
                choices: [],
                usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
              },
            },
            { data: "[DONE]" },
          ]),
      ],
    ]);
    const out = [];
    for await (const d of createChatModel({
      provider: "openai",
      model: "gpt-5-mini",
      apiKey: KEY,
      fetch,
    }).stream({
      system: "sys",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.5,
    })) {
      out.push(d);
    }
    expect(out).toEqual([
      { type: "text", text: "Hi" },
      { type: "usage", tokensIn: 5, tokensOut: 1 },
      { type: "done", finishReason: "stop" },
    ]);
    const body = calls[0]?.body as { messages: { role: string }[]; temperature?: number };
    expect(body.messages[0]?.role).toBe("developer");
    expect(body.temperature).toBeUndefined();
  });

  it("embeds with the requested dimension and verifies it in the connection test", async () => {
    const { fetch, calls } = fakeFetch([
      [
        "POST https://api.openai.com/v1/embeddings",
        (req) => {
          const dims = (req.body as { dimensions: number }).dimensions;
          return json({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: new Array(dims).fill(0.1) }],
            model: "m",
            usage: { prompt_tokens: 3, total_tokens: 3 },
          });
        },
      ],
    ]);
    const res = await testModel("embedding", {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: KEY,
      dimension: 1024,
      fetch,
    });
    expect(res).toMatchObject({ ok: true, dimension: 1024 });
    expect((calls[0]!.body as { dimensions: number }).dimensions).toBe(1024);
  });

  it("flags a dimension mismatch", async () => {
    const { fetch } = fakeFetch([
      [
        "/embeddings",
        () =>
          json({
            object: "list",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
            model: "m",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
      ],
    ]);
    const res = await testModel("embedding", {
      provider: "openai_compatible",
      baseUrl: "http://local/v1",
      model: "nomic",
      dimension: 768,
      fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/2-dimensional .* 768/);
  });

  it("rejects unsupported dimensions before calling the provider", async () => {
    const res = await testModel("embedding", {
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: KEY,
      dimension: 512,
    });
    expect(res).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("OpenAI-compatible endpoints", () => {
  it("requires a base URL", async () => {
    const res = await testModel("llm", { provider: "openai_compatible", model: "llama3" });
    expect(res.ok).toBe(false);
  });

  it("checks the model is served via /models", async () => {
    const { fetch } = fakeFetch([
      [
        "GET http://ollama:11434/v1/models",
        () => json({ object: "list", data: [{ id: "llama3", object: "model" }] }),
      ],
    ]);
    expect(
      (
        await testModel("llm", {
          provider: "openai_compatible",
          baseUrl: "http://ollama:11434/v1",
          model: "llama3",
          fetch,
        })
      ).ok,
    ).toBe(true);
    const missing = await testModel("llm", {
      provider: "openai_compatible",
      baseUrl: "http://ollama:11434/v1",
      model: "mistral",
      fetch,
    });
    expect(missing).toMatchObject({ ok: false, code: "not_found" });
  });

  it("falls back to a one-token completion when /models is not implemented", async () => {
    const { fetch, calls } = fakeFetch([
      ["GET http://llm/v1/models", () => json({ error: { message: "Not Found" } }, 404)],
      [
        "POST http://llm/v1/chat/completions",
        () =>
          json({
            id: "c",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "p" }, finish_reason: "length" }],
          }),
      ],
    ]);
    const res = await testModel("llm", {
      provider: "openai_compatible",
      baseUrl: "http://llm/v1",
      model: "m",
      fetch,
    });
    expect(res.ok).toBe(true);
    expect((calls[1]!.body as { max_tokens: number }).max_tokens).toBe(1);
  });

  it("maps connection failures to network errors", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await testModel("llm", {
      provider: "openai_compatible",
      baseUrl: "http://nowhere/v1",
      model: "m",
      fetch: failing,
    });
    expect(res).toMatchObject({ ok: false, code: "network" });
  });

  it("lists models", async () => {
    const { fetch } = fakeFetch([
      [
        "/v1/models",
        () =>
          json({
            object: "list",
            data: [
              { id: "b", object: "model" },
              { id: "a", object: "model" },
            ],
          }),
      ],
    ]);
    expect(await listModels({ provider: "openai_compatible", baseUrl: "http://x/v1", fetch })).toEqual([
      "a",
      "b",
    ]);
  });
});
