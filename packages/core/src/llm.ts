import type { ProviderErrorCode } from "./errors.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  /** Output cap. Defaults per provider; generous because answers are streamed. */
  maxTokens?: number;
  /** Ignored by providers/models that no longer accept sampling parameters (current Claude models). */
  temperature?: number;
  signal?: AbortSignal;
}

export type ChatDelta =
  | { type: "text"; text: string }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "done"; finishReason: "stop" | "length" | "refusal" | "error" | "other"; servedBy?: string };

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  code?: ProviderErrorCode;
  /** Embedding models: the vector size the provider actually returned. */
  dimension?: number;
}

export interface ChatModel {
  readonly provider: string;
  readonly model: string;
  stream(req: ChatRequest): AsyncIterable<ChatDelta>;
  /** Verifies the key and model without generating output where the provider allows it. */
  test(): Promise<ConnectionTestResult>;
}

export interface EmbeddingModel {
  readonly provider: string;
  readonly model: string;
  readonly dimension: number;
  readonly maxBatch: number;
  /** `query` vs `document` lets providers that distinguish them (Gemini, Voyage) use the right task type. */
  embed(texts: string[], kind: "query" | "document"): Promise<{ vectors: number[][]; tokens: number }>;
  test(): Promise<ConnectionTestResult>;
}
