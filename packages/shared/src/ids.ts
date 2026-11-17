import { randomBytes } from "node:crypto";

/** Publishable widget key. Safe to embed in customer HTML; access is constrained by allowed origins. */
export function newBotPublicKey(env: "live" | "test" = "live"): string {
  return `pk_${env}_${randomBytes(18).toString("base64url")}`;
}

export const BOT_PUBLIC_KEY_RE = /^pk_(live|test)_[A-Za-z0-9_-]{24}$/;
