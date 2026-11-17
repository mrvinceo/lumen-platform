import Anthropic from "@anthropic-ai/sdk";
import { toProviderError } from "../errors.js";
import type { ChatDelta, ChatModel, ChatRequest } from "../llm.js";
import { DEFAULT_TIMEOUT_MS, type ModelConfig, requireKey, runTest, TEST_TIMEOUT_MS } from "./common.js";

/**
 * Models that accept server-side refusal fallbacks. When one of these declines a request on safety grounds,
 * the API re-runs it on a suitable fallback model within the same call, so end users get an answer instead
 * of a dead end. Billed to the tenant's key at the fallback model's rates.
 */
const SERVER_FALLBACK_MODELS = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Streaming answers get a generous cap; truncating mid-answer is worse than paying for unused headroom. */
const DEFAULT_MAX_TOKENS = 64_000;

function client(cfg: ModelConfig, timeout = DEFAULT_TIMEOUT_MS): Anthropic {
  return new Anthropic({ apiKey: requireKey(cfg), fetch: cfg.fetch, timeout, maxRetries: 2 });
}

export function anthropicChatModel(cfg: ModelConfig): ChatModel {
  return {
    provider: "anthropic",
    model: cfg.model,

    test: () =>
      runTest(cfg.apiKey, async () => {
        // The Models API validates both the key and the model id without generating (or billing) output.
        const info = await client(cfg, TEST_TIMEOUT_MS).models.retrieve(cfg.model);
        return { message: `Connected. ${info.display_name} is available.` };
      }),

    async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
      const apiKey = cfg.apiKey;
      try {
        const anthropic = client(cfg);
        // Current Claude models reject temperature/top_p/top_k, so req.temperature is deliberately not sent.
        const base = {
          model: cfg.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        };
        const stream = SERVER_FALLBACK_MODELS.has(cfg.model)
          ? anthropic.beta.messages.stream(
              { ...base, betas: [FALLBACK_BETA], fallbacks: "default" },
              { signal: req.signal },
            )
          : anthropic.messages.stream(base, { signal: req.signal });

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          }
        }
        const final = await stream.finalMessage();
        yield { type: "usage", tokensIn: final.usage.input_tokens, tokensOut: final.usage.output_tokens };
        const reason = final.stop_reason;
        yield {
          type: "done",
          finishReason:
            reason === "end_turn" || reason === "stop_sequence"
              ? "stop"
              : reason === "max_tokens"
                ? "length"
                : reason === "refusal"
                  ? "refusal"
                  : "other",
          servedBy: final.model,
        };
      } catch (err) {
        throw toProviderError(err, apiKey);
      }
    },
  };
}

export async function listAnthropicModels(cfg: Omit<ModelConfig, "model">): Promise<string[]> {
  try {
    const ids: string[] = [];
    for await (const m of client({ ...cfg, model: "" }, TEST_TIMEOUT_MS).models.list()) ids.push(m.id);
    return ids;
  } catch (err) {
    throw toProviderError(err, cfg.apiKey);
  }
}
