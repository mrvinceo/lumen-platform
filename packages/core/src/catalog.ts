/**
 * Supported providers and suggested models. Suggestions are only a starting point: the console can also load
 * the live model list from the provider with the tenant's key, and any model id can be typed in.
 */
export const PROVIDER_IDS = ["anthropic", "openai", "google", "voyage", "openai_compatible"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ModelKind = "llm" | "embedding";

/** Dimensions the platform-managed pgvector store has tables for (see @lumen/db MANAGED_DIMENSIONS). */
export const SUPPORTED_DIMENSIONS = [768, 1024, 1536, 3072] as const;

export interface LlmModelInfo {
  id: string;
  label: string;
  recommended?: boolean;
}

export interface EmbeddingModelInfo {
  id: string;
  label: string;
  defaultDimension: number;
  /** Output sizes the model can produce that the platform can store. */
  dimensions: number[];
  recommended?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  kinds: ModelKind[];
  /** Whether a base URL can / must be supplied (Azure, Ollama, Mistral, Groq... via OpenAI-compatible). */
  baseUrl: "none" | "optional" | "required";
  keyRequired: boolean;
  keyPlaceholder: string;
  keyUrl?: string;
  llmModels: LlmModelInfo[];
  embeddingModels: EmbeddingModelInfo[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    kinds: ["llm"],
    baseUrl: "none",
    keyRequired: true,
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://platform.claude.com/settings/keys",
    llmModels: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", recommended: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
    ],
    embeddingModels: [],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    kinds: ["llm", "embedding"],
    baseUrl: "none",
    keyRequired: true,
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    llmModels: [
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 mini" },
    ],
    embeddingModels: [
      {
        id: "text-embedding-3-small",
        label: "text-embedding-3-small",
        defaultDimension: 1536,
        dimensions: [768, 1024, 1536],
        recommended: true,
      },
      {
        id: "text-embedding-3-large",
        label: "text-embedding-3-large",
        defaultDimension: 3072,
        dimensions: [768, 1024, 1536, 3072],
      },
    ],
  },
  google: {
    id: "google",
    name: "Google Gemini",
    kinds: ["llm", "embedding"],
    baseUrl: "none",
    keyRequired: true,
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    llmModels: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
    embeddingModels: [
      {
        id: "gemini-embedding-001",
        label: "gemini-embedding-001",
        defaultDimension: 768,
        dimensions: [768, 1536, 3072],
        recommended: true,
      },
    ],
  },
  voyage: {
    id: "voyage",
    name: "Voyage AI",
    kinds: ["embedding"],
    baseUrl: "none",
    keyRequired: true,
    keyPlaceholder: "pa-…",
    keyUrl: "https://dash.voyageai.com/api-keys",
    llmModels: [],
    embeddingModels: [
      {
        id: "voyage-3.5",
        label: "voyage-3.5",
        defaultDimension: 1024,
        dimensions: [1024],
        recommended: true,
      },
      { id: "voyage-3.5-lite", label: "voyage-3.5-lite", defaultDimension: 1024, dimensions: [1024] },
      { id: "voyage-3-large", label: "voyage-3-large", defaultDimension: 1024, dimensions: [1024] },
    ],
  },
  openai_compatible: {
    id: "openai_compatible",
    name: "OpenAI-compatible endpoint",
    kinds: ["llm", "embedding"],
    baseUrl: "required",
    keyRequired: false,
    keyPlaceholder: "API key (if the endpoint needs one)",
    llmModels: [],
    embeddingModels: [],
  },
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function supportsKind(provider: ProviderId, kind: ModelKind): boolean {
  return PROVIDERS[provider].kinds.includes(kind);
}

export function isSupportedDimension(n: number): boolean {
  return (SUPPORTED_DIMENSIONS as readonly number[]).includes(n);
}
