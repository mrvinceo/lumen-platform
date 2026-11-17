import { isSupportedDimension, type ModelKind, PROVIDERS, type ProviderId, supportsKind } from "./catalog.js";
import { ProviderError } from "./errors.js";
import type { ChatModel, ConnectionTestResult, EmbeddingModel } from "./llm.js";
import { anthropicChatModel, listAnthropicModels } from "./providers/anthropic.js";
import type { ModelConfig } from "./providers/common.js";
import { googleChatModel, googleEmbeddingModel, listGoogleModels } from "./providers/google.js";
import { listOpenAIModels, openaiChatModel, openaiEmbeddingModel } from "./providers/openai.js";
import { voyageEmbeddingModel } from "./providers/voyage.js";

export type { ModelConfig } from "./providers/common.js";

export function createChatModel(cfg: ModelConfig): ChatModel {
  assertKind(cfg.provider, "llm");
  switch (cfg.provider) {
    case "anthropic":
      return anthropicChatModel(cfg);
    case "openai":
    case "openai_compatible":
      return openaiChatModel(cfg);
    case "google":
      return googleChatModel(cfg);
    default:
      throw new ProviderError("bad_request", `${cfg.provider} does not provide chat models`);
  }
}

export function createEmbeddingModel(cfg: ModelConfig): EmbeddingModel {
  assertKind(cfg.provider, "embedding");
  const dimension = cfg.dimension;
  if (!dimension || !isSupportedDimension(dimension)) {
    throw new ProviderError("bad_request", `Embedding dimension must be one of 768, 1024, 1536 or 3072`);
  }
  const withDim = { ...cfg, dimension };
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
      return openaiEmbeddingModel(withDim);
    case "google":
      return googleEmbeddingModel(withDim);
    case "voyage":
      return voyageEmbeddingModel(withDim);
    default:
      throw new ProviderError("bad_request", `${cfg.provider} does not provide embedding models`);
  }
}

/** Tests a configuration of either kind, never throwing: failures come back as `{ ok: false, code, message }`. */
export async function testModel(kind: ModelKind, cfg: ModelConfig): Promise<ConnectionTestResult> {
  try {
    return await (kind === "llm" ? createChatModel(cfg) : createEmbeddingModel(cfg)).test();
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError("unknown", String(err));
    return { ok: false, latencyMs: 0, code: pe.code, message: pe.message };
  }
}

/** Live model list from the provider, using the tenant's key. Voyage has no list endpoint. */
export async function listModels(cfg: Omit<ModelConfig, "model">): Promise<string[]> {
  switch (cfg.provider) {
    case "anthropic":
      return listAnthropicModels(cfg);
    case "openai":
    case "openai_compatible":
      return listOpenAIModels(cfg);
    case "google":
      return listGoogleModels(cfg);
    case "voyage":
      return PROVIDERS.voyage.embeddingModels.map((m) => m.id);
  }
}

function assertKind(provider: ProviderId, kind: ModelKind): void {
  if (!PROVIDERS[provider]) throw new ProviderError("bad_request", `Unknown provider: ${provider}`);
  if (!supportsKind(provider, kind)) {
    throw new ProviderError(
      "bad_request",
      `${PROVIDERS[provider].name} does not provide ${kind === "llm" ? "chat" : "embedding"} models`,
    );
  }
}
