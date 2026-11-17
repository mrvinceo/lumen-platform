import { randomBytes } from "node:crypto";
import { aesGcmDecrypt, aesGcmEncrypt, type KeyProvider } from "./keyProvider.js";

/**
 * Envelope encryption for tenant secrets (LLM API keys, vector DB keys, OAuth refresh tokens...).
 * Every secret gets its own random DEK; the DEK is wrapped by the KeyProvider's KEK.
 * The tenant id and secret id are bound as AAD, so ciphertext copied to another tenant/row fails to decrypt.
 */
export interface SecretContext {
  tenantId: string;
  secretId: string;
}

export interface EncryptedSecret {
  /** base64(iv | tag | ciphertext) */
  ciphertext: string;
  wrappedDek: string;
  keyId: string;
  /** Non-sensitive hint for UIs, e.g. "abcd". */
  last4: string;
}

const VERSION = "v1";

function aadFor(ctx: SecretContext): Buffer {
  return Buffer.from(`${VERSION}|${ctx.tenantId}|${ctx.secretId}`, "utf8");
}

export async function encryptSecret(
  provider: KeyProvider,
  plaintext: string,
  ctx: SecretContext,
): Promise<EncryptedSecret> {
  if (!plaintext) throw new Error("Cannot encrypt an empty secret");
  const aad = aadFor(ctx);
  const dek = randomBytes(32);
  try {
    const ciphertext = aesGcmEncrypt(dek, Buffer.from(plaintext, "utf8"), aad).toString("base64");
    const wrappedDek = await provider.wrapKey(dek, aad);
    return { ciphertext, wrappedDek, keyId: provider.keyId, last4: lastFour(plaintext) };
  } finally {
    dek.fill(0);
  }
}

export async function decryptSecret(
  provider: KeyProvider,
  secret: Pick<EncryptedSecret, "ciphertext" | "wrappedDek" | "keyId">,
  ctx: SecretContext,
): Promise<string> {
  if (secret.keyId !== provider.keyId) {
    throw new Error(`Secret was wrapped with key "${secret.keyId}" but provider holds "${provider.keyId}"`);
  }
  const aad = aadFor(ctx);
  const dek = await provider.unwrapKey(secret.wrappedDek, aad);
  try {
    return aesGcmDecrypt(dek, Buffer.from(secret.ciphertext, "base64"), aad).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

export function lastFour(value: string): string {
  return value.length <= 8 ? "" : value.slice(-4);
}

/** Display form for secrets, e.g. "sk-…abcd". Never reveals more than the prefix and last 4 chars. */
export function maskSecret(last4: string, prefix = ""): string {
  return last4 ? `${prefix}…${last4}` : `${prefix}••••`;
}
