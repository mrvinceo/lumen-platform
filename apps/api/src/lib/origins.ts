import { HttpError } from "./errors.js";

/**
 * Normalises a domain the widget may be embedded on to an origin, e.g. "https://www.acme.com". Also accepts a
 * subdomain wildcard ("https://*.acme.com"), which Content-Security-Policy frame-ancestors supports.
 */
export function normaliseAllowedOrigin(raw: string, mode: "saas" | "selfhost"): string {
  const input = raw.trim().replace(/\/+$/, "");
  // No scheme typed: https, except localhost on self-hosted installs (local test servers are plain http).
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(input);
  const defaultScheme = local && mode === "selfhost" ? "http" : "https";
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `${defaultScheme}://${input}`;
  const wildcard = /^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i.exec(withScheme);
  let url: URL;
  try {
    url = new URL(wildcard ? `${wildcard[1]}://wildcard.${wildcard[2]}${wildcard[3] ?? ""}` : withScheme);
  } catch {
    throw new HttpError(400, "invalid_origin", `"${raw}" isn't a valid web address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "invalid_origin", `"${raw}" must start with https://.`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new HttpError(400, "invalid_origin", `Use just the site address for "${raw}", without a path.`);
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !(isLocal && mode === "selfhost")) {
    throw new HttpError(
      400,
      "invalid_origin",
      `"${raw}" must use https:// (http is only allowed for localhost on self-hosted installs).`,
    );
  }
  if (!isLocal && !url.hostname.includes(".")) {
    throw new HttpError(400, "invalid_origin", `"${raw}" isn't a full domain name.`);
  }
  const origin = url.origin;
  return wildcard ? origin.replace("://wildcard.", "://*.") : origin;
}

/** Value for Content-Security-Policy frame-ancestors: Lumen itself (console preview) plus the bot's domains. */
export function frameAncestors(selfOrigins: string[], allowed: string[]): string {
  const sources = new Set(["'self'", ...selfOrigins, ...allowed]);
  return [...sources].join(" ");
}

/** Whether a page origin is covered by an allowed-origin list (same matching as CSP: "*." matches subdomains only). */
export function originAllowed(origin: string, allowed: string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    if (entry === url.origin) return true;
    const m = /^(https?):\/\/\*\.([^:/]+)(:\d+)?$/.exec(entry);
    if (!m) return false;
    const port = m[3] ? m[3].slice(1) : "";
    return `${m[1]}:` === url.protocol && url.hostname.endsWith(`.${m[2]}`) && url.port === port;
  });
}
