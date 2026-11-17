import OpenAI from "openai";
import { toProviderError } from "../errors.js";
import type { ChatDelta, ChatModel, ChatRequest, EmbeddingModel } from "../llm.js";
import { DEFAULT_TIMEOUT_MS, type ModelConfig, runTest, TEST_TIMEOUT_MS } from "./common.js";

/** OpenAI itself, or any OpenAI-compatible endpoint (Azure OpenAI, Mistral, Groq, Together, Ollama, vLLM...). */
function client(cfg: Omit<ModelConfig, "model">, timeout = DEFAULT_TIMEOUT_MS): OpenAI {
  const compatible = cfg.provider === "openai_compatible";
  if (compatible && !cfg.baseUrl) throw toProviderError({ status: 400, message: "A base URL is required" });
  return new OpenAI({
    // Local endpoints such as Ollama accept any key; the SDK insists on a non-empty value.
    apiKey: cfg.apiKey || (compatible ? "not-needed" : undefined),
    baseURL: compatible ? cfg.baseUrl : undefined,
    fetch: cfg.fetch,
    timeout,
    maxRetries: 2,
  });
}

function finishReason(r: string | null | undefined): Extract<ChatDelta, { type: "done" }>["finishReason"] {
  if (r === "stop") return "stop";
  if (r === "length") return "length";
  if (r === "content_filter") return "refusal";
  return "other";
}

export function openaiChatModel(cfg: ModelConfig): ChatModel {
  const compatible = cfg.provider === "openai_compatible";
  return {
    provider: cfg.provider,
    model: cfg.model,

    test: () =>
      runTest(cfg.apiKey, async () => {
        const api = client(cfg, TEST_TIMEOUT_MS);
        if (!compatible) {
          await api.models.retrieve(cfg.model);
          return { message: `Connected. ${cfg.model} is available.` };
        }
        // Many compatible servers implement /models; fall back to a one-token completion if they don't.
        let ids: string[] | undefined;
        try {
          ids = [];
          for await (const m of api.models.list()) ids.push(m.id);
        } catch (err) {
          const pe = toProviderError(err, cfg.apiKey);
          if (pe.code !== "not_found") throw pe;
          ids = undefined;
        }
        if (ids && ids.length > 0) {
          if (!ids.includes(cfg.model)) {
            throw toProviderError({
              status: 404,
              message: `Model "${cfg.model}" is not served by this endpoint`,
            });
          }
          return { message: `Connected. ${cfg.model} is available.` };
        }
        await api.chat.completions.create({
          model: cfg.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        });
        return { message: `Connected. ${cfg.model} responded.` };
      }),

    async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
      try {
        const stream = await client(cfg).chat.completions.create(
          {
            model: cfg.model,
            stream: true,
            stream_options: { include_usage: true },
            messages: [
              { role: compatible ? "system" : "developer", content: req.system },
              ...req.messages.map((m) => ({ role: m.role, content: m.content })),
            ],
            ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
            // OpenAI's reasoning models only accept the default temperature; compatible servers usually honour it.
            ...(compatible && req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
          { signal: req.signal },
        );
        let reason: string | null | undefined;
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          const text = choice?.delta?.content;
          if (text) yield { type: "text", text };
          if (choice?.finish_reason) reason = choice.finish_reason;
          if (chunk.usage) {
            yield {
              type: "usage",
              tokensIn: chunk.usage.prompt_tokens,
              tokensOut: chunk.usage.completion_tokens,
            };
          }
        }
        yield { type: "done", finishReason: finishReason(reason) };
      } catch (err) {
        throw toProviderError(err, cfg.apiKey);
      }
    },
  };
}

export function openaiEmbeddingModel(cfg: ModelConfig & { dimension: number }): EmbeddingModel {
  const compatible = cfg.provider === "openai_compatible";
  const embed = async (texts: string[]) => {
    try {
      const res = await client(cfg).embeddings.create({
        model: cfg.model,
        input: texts,
        // text-embedding-3 models can shorten their output; compatible servers often reject the parameter.
        ...(compatible ? {} : { dimensions: cfg.dimension }),
        encoding_format: "float",
      });
      const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
      return { vectors, tokens: res.usage?.total_tokens ?? 0 };
    } catch (err) {
      throw toProviderError(err, cfg.apiKey);
    }
  };
  return {
    provider: cfg.provider,
    model: cfg.model,
    dimension: cfg.dimension,
    maxBatch: 256,
    embed: (texts) => embed(texts),
    test: () =>
      runTest(cfg.apiKey, async () => {
        const { vectors } = await embed(["Lumen connection test"]);
        return checkDimension(vectors[0]?.length ?? 0, cfg.dimension);
      }),
  };
}

export function checkDimension(actual: number, expected: number): { message: string; dimension: number } {
  if (actual !== expected) {
    throw toProviderError({
      status: 400,
      message: `The model returned ${actual}-dimensional vectors but ${expected} was configured`,
    });
  }
  return { message: `Connected. Returns ${actual}-dimensional vectors.`, dimension: actual };
}

export async function listOpenAIModels(cfg: Omit<ModelConfig, "model">): Promise<string[]> {
  try {
    const ids: string[] = [];
    for await (const m of client(cfg, TEST_TIMEOUT_MS).models.list()) ids.push(m.id);
    return ids.sort();
  } catch (err) {
    throw toProviderError(err, cfg.apiKey);
  }
}
