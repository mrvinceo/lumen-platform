import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingModel, testModel } from "../src/index.js";
import { fakeFetch, json } from "./fakeFetch.js";

describe("Voyage adapter", () => {
  it("sends input_type and output_dimension", async () => {
    const { fetch, calls } = fakeFetch([
      [
        "POST https://api.voyageai.com/v1/embeddings",
        () => json({ data: [{ embedding: new Array(1024).fill(0), index: 0 }], usage: { total_tokens: 4 } }),
      ],
    ]);
    const model = createEmbeddingModel({
      provider: "voyage",
      model: "voyage-3.5",
      apiKey: "pa-key-0123456789abcdefghijk",
      dimension: 1024,
      fetch,
    });
    const { vectors, tokens } = await model.embed(["hello"], "document");
    expect(vectors[0]).toHaveLength(1024);
    expect(tokens).toBe(4);
    expect(calls[0]?.body).toMatchObject({
      input_type: "document",
      output_dimension: 1024,
      model: "voyage-3.5",
    });
  });

  it("maps HTTP errors", async () => {
    const { fetch } = fakeFetch([["voyageai", () => json({ detail: "Provided API key is invalid." }, 401)]]);
    const res = await testModel("embedding", {
      provider: "voyage",
      model: "voyage-3.5",
      apiKey: "bad-key-123456789",
      dimension: 1024,
      fetch,
    });
    expect(res).toMatchObject({ ok: false, code: "auth" });
  });
});

describe("Google Gemini adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tests a chat model via models.get", async () => {
    const { fetch, calls } = fakeFetch([
      [
        "models/gemini-2.5-flash",
        () => json({ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }),
      ],
    ]);
    vi.stubGlobal("fetch", fetch);
    const res = await testModel("llm", {
      provider: "google",
      model: "gemini-2.5-flash",
      apiKey: "AIza-test-key-0123456789abcdef",
    });
    expect(res).toMatchObject({ ok: true });
    expect(res.message).toContain("Gemini 2.5 Flash");
    expect(calls[0]?.url).toContain("generativelanguage.googleapis.com");
  });

  it("returns unit-length vectors at the requested dimension", async () => {
    const { fetch, calls } = fakeFetch([
      ["mbedContent", () => json({ embeddings: [{ values: new Array(768).fill(2) }] })],
    ]);
    vi.stubGlobal("fetch", fetch);
    const model = createEmbeddingModel({
      provider: "google",
      model: "gemini-embedding-001",
      apiKey: "AIza-test-key-0123456789abcdef",
      dimension: 768,
    });
    const { vectors } = await model.embed(["q"], "query");
    const v = vectors[0] ?? [];
    expect(v).toHaveLength(768);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
    expect(JSON.stringify(calls[0]?.body)).toContain("RETRIEVAL_QUERY");
  });
});
