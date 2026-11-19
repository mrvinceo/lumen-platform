import { type ChatEvent, type Citation, streamChatEvents } from "@lumen/chat-ui";

export type { ChatEvent, ChatSource, Citation } from "@lumen/chat-ui";

/** Thin fetch wrapper for the Lumen API. Errors carry the server's `{ error: { code, message, details } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    credentials: "include",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(
      res.status,
      e?.code ?? "error",
      e?.message ?? `Request failed (${res.status})`,
      e?.details,
    );
  }
  return data as T;
}

export type Role = "owner" | "admin" | "editor" | "viewer";
export type ModelKind = "llm" | "embedding";

export interface Me {
  user: { id: string; email: string; name: string | null };
  tenant: { id: string; name: string; slug: string; role: Role } | null;
  tenants: { id: string; name: string; slug: string; role: Role }[];
  /** False when the server has sign-ups (and new workspaces) turned off. */
  canCreateWorkspace: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kinds: ModelKind[];
  baseUrl: "none" | "optional" | "required";
  keyRequired: boolean;
  keyPlaceholder: string;
  keyUrl?: string;
  llmModels: { id: string; label: string; recommended?: boolean }[];
  embeddingModels: {
    id: string;
    label: string;
    defaultDimension: number;
    dimensions: number[];
    recommended?: boolean;
  }[];
}

export interface Catalog {
  providers: ProviderInfo[];
  dimensions: number[];
}

export interface ProviderConfig {
  id: string;
  type: ModelKind;
  provider: string;
  providerName: string;
  model: string;
  label: string;
  baseUrl: string | null;
  dimension: number | null;
  hasKey: boolean;
  keyHint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  code?: string;
  dimension?: number;
}

export const canManage = (role: Role | undefined) => role === "owner" || role === "admin";

export const canEdit = (role: Role | undefined) => role === "owner" || role === "admin" || role === "editor";

export type Audience = "public" | "staff";

export interface VectorStoreInfo {
  id: string;
  provider: "pgvector_managed" | "pinecone" | "firestore";
  providerName: string;
  label: string;
  managed: boolean;
  config: Record<string, unknown>;
  keyHint: string | null;
  lastCheck: { ok: boolean | null; message: string | null; checkedAt: string } | null;
  knowledgeBases: number;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  dimension: number;
  createdAt: string;
  embeddingConfigId: string;
  embeddingLabel: string;
  embeddingModel: string;
  vectorStoreId: string;
  vectorStoreLabel: string;
  vectorStoreProvider: string;
  documentCount: number;
  indexedCount: number;
  pendingCount: number;
  errorCount: number;
  chunkCount: number;
}

export interface KbDocument {
  id: string;
  title: string;
  mimeType: string | null;
  sizeBytes: number | null;
  audience: Audience;
  status: "pending" | "indexing" | "indexed" | "excluded" | "error";
  error: string | null;
  chunkCount: number;
  tokenCount: number;
  indexedAt: string | null;
  createdAt: string;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  score: number;
  text: string;
  headings: string[];
  page?: number;
  audience: Audience;
}

/** Multipart upload; returns accepted documents and per-file rejections. */
export async function uploadFiles(kbId: string, files: File[], audience: Audience) {
  const form = new FormData();
  form.append("audience", audience);
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch(`/api/v1/knowledge-bases/${kbId}/documents`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as {
    documents?: KbDocument[];
    rejected?: { filename: string; reason: string }[];
    error?: { code?: string; message?: string };
  };
  if (!res.ok && !data.rejected) {
    throw new ApiError(
      res.status,
      data.error?.code ?? "error",
      data.error?.message ?? `Upload failed (${res.status})`,
    );
  }
  return { documents: data.documents ?? [], rejected: data.rejected ?? [] };
}

export interface Bot {
  id: string;
  name: string;
  kbIds: string[];
  llmConfigId: string;
  systemPrompt: string;
  grounding: "strict" | "lenient";
  fallbackMessage: string;
  topK: number;
  publicKey: string;
  llmLabel: string;
  llmModel: string;
  knowledgeBases: { id: string; name: string }[];
  conversationCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  branding: BotBranding;
  allowedOrigins: string[];
  widgetEnabled: boolean;
  hostedPageEnabled: boolean;
  monthlyMessageCap: number | null;
  publicAnswersThisMonth: number;
}

export interface BotBranding {
  title?: string;
  greeting?: string;
  primaryColor?: string;
  logoUrl?: string;
  logoBackground?: string;
  suggestedQuestions?: string[];
  position?: "bottom-right" | "bottom-left";
  theme?: "light" | "dark" | "auto";
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  channel: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  status: "complete" | "error" | "stopped";
  error: string | null;
  feedback: "up" | "down" | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  retrieval: {
    query: string;
    condensed: boolean;
    sources: { n: number; title: string; score: number; via: string[] }[];
    timingsMs?: { condense?: number; retrieve?: number; firstToken?: number; total?: number };
  } | null;
  createdAt: string;
}

/** Streams a playground chat turn (Server-Sent Events over a POST). */
export function streamChat(
  botId: string,
  body: { message: string; conversationId?: string; includeStaff: boolean },
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  return streamChatEvents(`/api/v1/bots/${botId}/chat`, body, { signal, credentials: "include" });
}
