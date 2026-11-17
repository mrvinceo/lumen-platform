import { GoogleGenAI } from "@google/genai";
import { toProviderError } from "../errors.js";
import type { ChatDelta, ChatModel, ChatRequest, EmbeddingModel } from "../llm.js";
import { type ModelConfig, requireKey, runTest } from "./common.js";
import { checkDimension } from "./openai.js";

function client(cfg: Omit<ModelConfig, "model">): GoogleGenAI {
  return new GoogleGenAI({ apiKey: requireKey({ ...cfg, model: "" }) });
}

function finishReason(r: string | undefined): Extract<ChatDelta, { type: "done" }>["finishReason"] {
  if (r === "STOP") return "stop";
  if (r === "MAX_TOKENS") return "length";
  if (r === "SAFETY" || r === "PROHIBITED_CONTENT" || r === "BLOCKLIST" || r === "RECITATION")
    return "refusal";
  return "other";
}

export function googleChatModel(cfg: ModelConfig): ChatModel {
  return {
    provider: "google",
    model: cfg.model,

    test: () =>
      runTest(cfg.apiKey, async () => {
        const info = await client(cfg).models.get({ model: cfg.model });
        return { message: `Connected. ${info.displayName ?? cfg.model} is available.` };
      }),

    async *stream(req: ChatRequest): AsyncIterable<ChatDelta> {
      try {
        const stream = await client(cfg).models.generateContentStream({
          model: cfg.model,
          contents: req.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          config: {
            systemInstruction: req.system,
            ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            abortSignal: req.signal,
          },
        });
        let reason: string | undefined;
        let usage: { tokensIn: number; tokensOut: number } | undefined;
        for await (const chunk of stream) {
          const text = chunk.text;
          if (text) yield { type: "text", text };
          const fr = chunk.candidates?.[0]?.finishReason;
          if (fr) reason = fr;
          if (chunk.usageMetadata) {
            usage = {
              tokensIn: chunk.usageMetadata.promptTokenCount ?? 0,
              tokensOut: chunk.usageMetadata.candidatesTokenCount ?? 0,
            };
          }
        }
        if (usage) yield { type: "usage", ...usage };
        yield { type: "done", finishReason: finishReason(reason) };
      } catch (err) {
        throw toProviderError(err, cfg.apiKey);
      }
    },
  };
}

export function googleEmbeddingModel(cfg: ModelConfig & { dimension: number }): EmbeddingModel {
  const embed = async (texts: string[], kind: "query" | "document") => {
    try {
      const res = await client(cfg).models.embedContent({
        model: cfg.model,
        contents: texts,
        config: {
          outputDimensionality: cfg.dimension,
          taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        },
      });
      const vectors = (res.embeddings ?? []).map((e) => normalize(e.values ?? []));
      return { vectors, tokens: 0 };
    } catch (err) {
      throw toProviderError(err, cfg.apiKey);
    }
  };
  return {
    provider: "google",
    model: cfg.model,
    dimension: cfg.dimension,
    maxBatch: 100,
    embed,
    test: () =>
      runTest(cfg.apiKey, async () => {
        const { vectors } = await embed(["Lumen connection test"], "query");
        return checkDimension(vectors[0]?.length ?? 0, cfg.dimension);
      }),
  };
}

/** Gemini only normalises full-size (3072) embeddings; truncated ones must be normalised for cosine search. */
function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

export async function listGoogleModels(cfg: Omit<ModelConfig, "model">): Promise<string[]> {
  try {
    const ids: string[] = [];
    const pager = await client(cfg).models.list();
    for await (const m of pager) if (m.name) ids.push(m.name.replace(/^models\//, ""));
    return ids.sort();
  } catch (err) {
    throw toProviderError(err, cfg.apiKey);
  }
}
