import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";

export interface VisitorClaims {
  tenantId: string;
  botId: string;
  visitorId: string;
  channel: "widget" | "hosted";
  /** Expiry, seconds since epoch. */
  exp: number;
}

/** Key for visitor tokens, derived from MASTER_KEY so there is no extra secret to manage. */
export function visitorTokenKey(masterKeyBase64: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(masterKeyBase64, "base64"), Buffer.alloc(0), "lumen-visitor-token-v1", 32),
  );
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Compact signed token: base64url(JSON claims) + "." + base64url(HMAC-SHA256). */
export function signVisitorToken(
  key: Buffer,
  claims: Omit<VisitorClaims, "exp">,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const payload = b64(JSON.stringify({ v: 1, ...claims, exp: Math.floor(now / 1000) + ttlSeconds }));
  const sig = b64(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyVisitorToken(key: Buffer, token: string, now = Date.now()): VisitorClaims | undefined {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return undefined;
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as VisitorClaims & { v: number };
    if (c.v !== 1 || typeof c.exp !== "number" || c.exp * 1000 < now) return undefined;
    if (c.channel !== "widget" && c.channel !== "hosted") return undefined;
    return { tenantId: c.tenantId, botId: c.botId, visitorId: c.visitorId, channel: c.channel, exp: c.exp };
  } catch {
    return undefined;
  }
}

/** Visitor ids are random and opaque; a client-supplied one is reused only if it has the right shape. */
export function visitorIdOrNew(candidate: unknown): string {
  return typeof candidate === "string" && /^v_[A-Za-z0-9-]{20,40}$/.test(candidate)
    ? candidate
    : `v_${randomUUID()}`;
}
