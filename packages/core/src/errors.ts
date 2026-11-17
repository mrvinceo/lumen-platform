/** Provider-agnostic error categories, so the console can show actionable messages for any provider. */
export type ProviderErrorCode =
  | "auth" // missing / invalid / revoked API key
  | "permission" // key valid but not allowed to use this model or endpoint
  | "not_found" // unknown model or bad base URL path
  | "rate_limit"
  | "quota" // billing / credit exhausted
  | "bad_request"
  | "network" // DNS, TLS, connection refused, timeout
  | "provider" // 5xx / overloaded
  | "unknown";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;

  constructor(code: ProviderErrorCode, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.code = code;
    this.status = opts.status;
  }
}

const MESSAGES: Record<ProviderErrorCode, string> = {
  auth: "The API key was rejected. Check that it is correct and has not been revoked.",
  permission: "The API key is valid but is not allowed to use this model or endpoint.",
  not_found: "The model or endpoint was not found. Check the model name and base URL.",
  rate_limit: "The provider is rate-limiting this key. Try again shortly.",
  quota: "The provider account has run out of credit or quota.",
  bad_request: "The provider rejected the request.",
  network: "Could not reach the provider. Check the base URL and network access.",
  provider: "The provider returned a server error. Try again shortly.",
  unknown: "The provider returned an unexpected error.",
};

export function codeForStatus(status: number | undefined): ProviderErrorCode {
  if (status === undefined) return "network";
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider";
  if (status >= 400) return "bad_request";
  return "unknown";
}

/**
 * Normalises SDK errors (Anthropic, OpenAI, Google GenAI, fetch) into a ProviderError.
 * The provider's own message is kept as detail, but never contains the API key.
 */
export function toProviderError(err: unknown, apiKey?: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { status?: unknown; code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
  const status = typeof e?.status === "number" ? e.status : statusFromErrorName(e?.name);
  let code = codeForStatus(status);
  const raw = typeof e?.message === "string" ? e.message : String(err);
  if (status === undefined) {
    const looksNetwork =
      /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|network|timed? ?out|Connection error/i.test(
        raw,
      ) || e?.name === "APIConnectionError";
    code = looksNetwork ? "network" : "unknown";
  }
  if (code === "rate_limit" && /quota|billing|credit|insufficient/i.test(raw)) code = "quota";
  const detail = redact(raw, apiKey);
  return new ProviderError(code, `${MESSAGES[code]}${detail ? ` (${truncate(detail, 300)})` : ""}`, {
    status,
    cause: err,
  });
}

/** Some SDKs (e.g. Pinecone) signal HTTP failures with error classes rather than a status field. */
function statusFromErrorName(name: unknown): number | undefined {
  if (typeof name !== "string") return undefined;
  if (/Authoriz|Authentic|Unauthori/.test(name)) return 401;
  if (/Forbidden|Permission/.test(name)) return 403;
  if (/NotFound/.test(name)) return 404;
  if (/RateLimit|TooManyRequests/.test(name)) return 429;
  if (/BadRequest|ArgumentError/.test(name)) return 400;
  if (/Internal|ServerError|Unavailable/.test(name)) return 503;
  return undefined;
}

function redact(text: string, apiKey?: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join("[redacted]");
  // Generic key-shaped tokens (sk-..., AIza..., pa-...)
  return out.replace(
    /\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|pa-[A-Za-z0-9_-]{20,})\b/g,
    "[redacted]",
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
