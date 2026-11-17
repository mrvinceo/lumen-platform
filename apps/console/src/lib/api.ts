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
