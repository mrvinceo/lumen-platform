import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Wraps/unwraps data-encryption keys (DEKs) with a key-encryption key (KEK).
 * SaaS deployments plug in a cloud KMS; self-host uses a local master key from env.
 */
export interface KeyProvider {
  /** Stable identifier persisted alongside each wrapped DEK, enabling key rotation. */
  readonly keyId: string;
  wrapKey(dek: Buffer, aad: Buffer): Promise<string>;
  unwrapKey(wrapped: string, aad: Buffer): Promise<Buffer>;
}

const IV_LEN = 12;
const TAG_LEN = 16;

export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function aesGcmDecrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) throw new Error("Ciphertext too short");
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** KEK held in process memory, supplied via the MASTER_KEY env var (32 bytes, base64). */
export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  readonly #kek: Buffer;

  constructor(masterKeyBase64: string, keyId = "local-v1") {
    const kek = Buffer.from(masterKeyBase64, "base64");
    if (kek.length !== 32) {
      throw new Error(
        "MASTER_KEY must be 32 bytes encoded as base64 (generate with: openssl rand -base64 32)",
      );
    }
    this.#kek = kek;
    this.keyId = keyId;
  }

  async wrapKey(dek: Buffer, aad: Buffer): Promise<string> {
    return aesGcmEncrypt(this.#kek, dek, aad).toString("base64");
  }

  async unwrapKey(wrapped: string, aad: Buffer): Promise<Buffer> {
    return aesGcmDecrypt(this.#kek, Buffer.from(wrapped, "base64"), aad);
  }
}

export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  const kind = env.KEY_PROVIDER ?? "local";
  if (kind === "local") {
    if (!env.MASTER_KEY) throw new Error("MASTER_KEY is required when KEY_PROVIDER=local");
    return new LocalKeyProvider(env.MASTER_KEY, env.MASTER_KEY_ID ?? "local-v1");
  }
  // Cloud KMS providers (gcp-kms, aws-kms) are added in a later phase.
  throw new Error(`Unsupported KEY_PROVIDER: ${kind}`);
}
