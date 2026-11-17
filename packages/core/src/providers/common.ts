import type { ProviderId } from "../catalog.js";
import { toProviderError } from "../errors.js";
import type { ConnectionTestResult } from "../llm.js";

export interface ModelConfig {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Embedding output size. */
  dimension?: number;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const TEST_TIMEOUT_MS = 15_000;

/** Runs a connection check and turns any failure into a result the console can display. */
export async function runTest(
  apiKey: string | undefined,
  check: () => Promise<{ message: string; dimension?: number }>,
): Promise<ConnectionTestResult> {
  const started = performance.now();
  try {
    const { message, dimension } = await check();
    return { ok: true, latencyMs: Math.round(performance.now() - started), message, dimension };
  } catch (err) {
    const pe = toProviderError(err, apiKey);
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      message: pe.message,
      code: pe.code,
    };
  }
}

export function requireKey(cfg: ModelConfig): string {
  if (!cfg.apiKey) throw toProviderError({ status: 401, message: "No API key configured" });
  return cfg.apiKey;
}
