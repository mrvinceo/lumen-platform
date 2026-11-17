export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ChatDelta =
  | { type: "text"; text: string }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "done"; finishReason: string };

export interface ChatModel {
  readonly provider: string;
  readonly model: string;
  stream(req: ChatRequest): AsyncIterable<ChatDelta>;
}

export interface EmbeddingModel {
  readonly provider: string;
  readonly model: string;
  readonly dimension: number;
  readonly maxBatch: number;
  /** `query` vs `document` lets providers that distinguish them (Gemini, Voyage, Cohere) use the right task type. */
  embed(texts: string[], kind: "query" | "document"): Promise<{ vectors: number[][]; tokens: number }>;
}
