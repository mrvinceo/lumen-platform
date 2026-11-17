import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./errors.js";

/**
 * Validates a tenant-supplied base URL (OpenAI-compatible endpoints).
 *
 * In SaaS mode the API would otherwise make requests to any address a tenant names, including internal
 * services and cloud metadata endpoints (SSRF). There we require https and refuse hosts that resolve to
 * private, loopback or link-local addresses. Self-hosted installs allow them: a local Ollama or vLLM server
 * is a primary use case.
 */
export async function assertSafeBaseUrl(raw: string, mode: "saas" | "selfhost"): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_base_url", "Base URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "invalid_base_url", "Base URL must start with http:// or https://.");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "invalid_base_url", "Put credentials in the API key field, not the URL.");
  }
  if (mode === "saas") {
    if (url.protocol !== "https:") throw new HttpError(400, "invalid_base_url", "Base URL must use https.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (addresses.length === 0) throw new HttpError(400, "invalid_base_url", `Could not resolve ${host}.`);
    if (addresses.some(isPrivateAddress)) {
      throw new HttpError(400, "invalid_base_url", "Base URL must point to a public address.");
    }
  }
  return url.toString().replace(/\/$/, "");
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const parts = ip.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
