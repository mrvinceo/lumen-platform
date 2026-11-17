import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, LocalKeyProvider, maskSecret } from "../src/index.js";

const provider = new LocalKeyProvider(randomBytes(32).toString("base64"));
const ctx = { tenantId: "tenant-a", secretId: "secret-1" };

describe("envelope encryption", () => {
  it("round-trips a secret", async () => {
    const enc = await encryptSecret(provider, "sk-test-1234567890abcd", ctx);
    expect(enc.ciphertext).not.toContain("sk-test");
    expect(enc.last4).toBe("abcd");
    expect(await decryptSecret(provider, enc, ctx)).toBe("sk-test-1234567890abcd");
  });

  it("produces different ciphertext each time", async () => {
    const a = await encryptSecret(provider, "same-secret-value", ctx);
    const b = await encryptSecret(provider, "same-secret-value", ctx);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
  });

  it("refuses to decrypt under another tenant's context", async () => {
    const enc = await encryptSecret(provider, "sk-tenant-a-secret", ctx);
    await expect(decryptSecret(provider, enc, { ...ctx, tenantId: "tenant-b" })).rejects.toThrow();
    await expect(decryptSecret(provider, enc, { ...ctx, secretId: "secret-2" })).rejects.toThrow();
  });

  it("refuses to decrypt with a different master key", async () => {
    const enc = await encryptSecret(provider, "sk-tenant-a-secret", ctx);
    const other = new LocalKeyProvider(randomBytes(32).toString("base64"));
    await expect(decryptSecret(other, enc, ctx)).rejects.toThrow();
  });

  it("detects tampering", async () => {
    const enc = await encryptSecret(provider, "sk-tenant-a-secret", ctx);
    const raw = Buffer.from(enc.ciphertext, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    await expect(
      decryptSecret(provider, { ...enc, ciphertext: raw.toString("base64") }, ctx),
    ).rejects.toThrow();
  });

  it("rejects malformed master keys", () => {
    expect(() => new LocalKeyProvider("too-short")).toThrow(/32 bytes/);
  });

  it("masks secrets", () => {
    expect(maskSecret("abcd", "sk-")).toBe("sk-…abcd");
    expect(maskSecret("")).toBe("••••");
  });
});
