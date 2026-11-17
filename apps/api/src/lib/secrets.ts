import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, type KeyProvider } from "@lumen/crypto";
import { and, eq, schema, type Tx } from "@lumen/db";

type SecretKind = (typeof schema.secretKindEnum.enumValues)[number];

/** Encrypts and stores a tenant secret. Must run inside withTenant(). Returns the new secret's id. */
export async function storeSecret(
  tx: Tx,
  keys: KeyProvider,
  input: { tenantId: string; kind: SecretKind; label: string; value: string },
): Promise<{ id: string; last4: string }> {
  const id = randomUUID();
  const enc = await encryptSecret(keys, input.value, { tenantId: input.tenantId, secretId: id });
  await tx.insert(schema.secrets).values({
    id,
    tenantId: input.tenantId,
    kind: input.kind,
    label: input.label,
    ciphertext: enc.ciphertext,
    wrappedDek: enc.wrappedDek,
    keyId: enc.keyId,
    last4: enc.last4,
  });
  return { id, last4: enc.last4 };
}

/** Decrypts a tenant secret. Must run inside withTenant(); RLS guarantees it belongs to that tenant. */
export async function readSecret(
  tx: Tx,
  keys: KeyProvider,
  tenantId: string,
  secretId: string,
): Promise<string> {
  const [row] = await tx
    .select()
    .from(schema.secrets)
    .where(and(eq(schema.secrets.id, secretId), eq(schema.secrets.tenantId, tenantId)));
  if (!row) throw new Error("Secret not found");
  return decryptSecret(keys, row, { tenantId, secretId });
}
