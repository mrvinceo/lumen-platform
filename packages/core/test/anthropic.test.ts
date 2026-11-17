import { describe, expect, it } from "vitest";
import { createChatModel } from "../src/index.js";
import { fakeFetch, json, sse } from "./fakeFetch.js";

const KEY = "sk-ant-test-0123456789abcdef";

const messageStream = (model: string) =>
  sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

describe("Anthropic adapter", () => {
  it("tests the connection with the Models API (no tokens generated)", async () => {
    const { fetch, calls } = fakeFetch([
      [
        "GET https://api.anthropic.com/v1/models/claude-opus-5-5",
        () =>
          json({
            id: "claude-opus-5-5",
            display_name: "Claude Opus 5.5",
            type: "model",
            created_at: "2026-01-01",
          }),
      ],
    ]);
    const res = await createChatModel({
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: KEY,
      fetch,
    }).test();
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Claude Opus 5.5");
    const h = calls[0]?.headers ?? {};
    expect(h["x-api-key"] ?? h.authorization?.replace(/^Bearer /, "")).toBe(KEY);
    expect(calls.some((c) => c.url.includes("/v1/messages"))).toBe(false);
  });

  it("reports an invalid key as an auth failure without echoing the key", async () => {
    const { fetch } = fakeFetch([
      [
        "/v1/models/",
        () =>
          json(
            { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } },
            401,
          ),
      ],
    ]);
    const res = await createChatModel({
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: KEY,
      fetch,
    }).test();
    expect(res).toMatchObject({ ok: false, code: "auth" });
    expect(res.message).not.toContain(KEY);
  });

  it("reports an unknown model as not_found", async () => {
    const { fetch } = fakeFetch([
      [
        "/v1/models/",
        () => json({ type: "error", error: { type: "not_found_error", message: "model: nope" } }, 404),
      ],
    ]);
    const res = await createChatModel({ provider: "anthropic", model: "nope", apiKey: KEY, fetch }).test();
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });

  it("streams text, usage and finish reason, with server-side fallbacks and no sampling params", async () => {
    const { fetch, calls } = fakeFetch([
      ["POST https://api.anthropic.com/v1/messages", () => messageStream("claude-opus-5-5")],
    ]);
    const model = createChatModel({ provider: "anthropic", model: "claude-opus-5-5", apiKey: KEY, fetch });
    const out = [];
    for await (const d of model.stream({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.2,
    })) {
      out.push(d);
    }
    expect(
      out
        .filter((d) => d.type === "text")
        .map((d) => (d as { text: string }).text)
        .join(""),
    ).toBe("Hello there");
    expect(out).toContainEqual({ type: "usage", tokensIn: 12, tokensOut: 7 });
    expect(out.at(-1)).toEqual({ type: "done", finishReason: "stop", servedBy: "claude-opus-5-5" });

    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.fallbacks).toBe("default");
    expect(body.temperature).toBeUndefined();
    expect(body.system).toBe("Answer briefly.");
    expect(calls[0]?.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
  });

  it("uses the standard endpoint for models without server-side fallbacks", async () => {
    const { fetch, calls } = fakeFetch([
      ["POST https://api.anthropic.com/v1/messages", () => messageStream("claude-haiku-5-5")],
    ]);
    const model = createChatModel({ provider: "anthropic", model: "claude-haiku-5-5", apiKey: KEY, fetch });
    for await (const _ of model.stream({ system: "", messages: [{ role: "user", content: "Hi" }] })) {
      // drain
    }
    expect((calls[0]!.body as Record<string, unknown>).fallbacks).toBeUndefined();
    expect(calls[0]?.headers["anthropic-beta"]).toBeUndefined();
  });
});
