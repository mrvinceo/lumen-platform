import { randomUUID } from "node:crypto";
import { type Database, type Tx, withSystem, withTenant } from "../src/client.js";
import * as s from "../src/schema/index.js";

export interface TenantFixture {
  tenantId: string;
  userId: string;
  secretId: string;
  embeddingConfigId: string;
  llmConfigId: string;
  vectorStoreId: string;
  kbId: string;
  sourceId: string;
  documentId: string;
  chunkId: string;
  botId: string;
  conversationId: string;
}

export function unitVector(dim: number, hot: number): number[] {
  const v = new Array<number>(dim).fill(0);
  v[hot % dim] = 1;
  return v;
}

/** Creates a tenant with one row in every tenant-scoped table. */
export async function seedTenant(db: Database, label: string): Promise<TenantFixture> {
  const suffix = randomUUID().slice(0, 8);
  const userId = `user_${label}_${suffix}`;
  const tenantId = await withSystem(db, async (sys) => {
    const [tenant] = await sys
      .insert(s.tenants)
      .values({ name: `Tenant ${label}`, slug: `${label}-${suffix}` })
      .returning({ id: s.tenants.id });
    await sys.insert(s.users).values({ id: userId, email: `${label}-${suffix}@example.test` });
    return tenant!.id;
  });

  return withTenant(db, tenantId, async (tx: Tx) => {
    await tx.insert(s.members).values({ tenantId, userId, role: "owner" });
    const [secret] = await tx
      .insert(s.secrets)
      .values({
        tenantId,
        kind: "llm_api_key",
        label: "key",
        ciphertext: "x",
        wrappedDek: "y",
        keyId: "local-v1",
      })
      .returning();
    const [emb] = await tx
      .insert(s.providerConfigs)
      .values({
        tenantId,
        type: "embedding",
        provider: "openai",
        model: "m",
        label: "emb",
        secretId: secret!.id,
      })
      .returning();
    const [llm] = await tx
      .insert(s.providerConfigs)
      .values({ tenantId, type: "llm", provider: "openai", model: "m", label: "llm", secretId: secret!.id })
      .returning();
    const [vs] = await tx
      .insert(s.vectorStores)
      .values({ tenantId, provider: "pgvector_managed", label: "managed" })
      .returning();
    const [kb] = await tx
      .insert(s.knowledgeBases)
      .values({
        tenantId,
        name: "KB",
        embeddingConfigId: emb!.id,
        vectorStoreId: vs!.id,
        dimension: 768,
        namespace: `kb_${suffix}`,
      })
      .returning();
    const [source] = await tx
      .insert(s.sources)
      .values({ tenantId, kbId: kb!.id, type: "upload", name: "Uploads" })
      .returning();
    const [doc] = await tx
      .insert(s.documents)
      .values({
        tenantId,
        kbId: kb!.id,
        sourceId: source!.id,
        externalId: `file-${suffix}`,
        title: `${label} handbook`,
      })
      .returning();
    const [chunk] = await tx
      .insert(s.chunks)
      .values({
        tenantId,
        kbId: kb!.id,
        documentId: doc!.id,
        ordinal: 0,
        text: `${label} refund policy secret`,
        tokenCount: 4,
        contentHash: "h",
      })
      .returning();
    await tx
      .insert(s.embeddings768)
      .values({ chunkId: chunk!.id, tenantId, kbId: kb!.id, embedding: unitVector(768, 0) });
    await tx.insert(s.ingestionJobs).values({ tenantId, sourceId: source!.id, kind: "full_sync" });
    const [bot] = await tx
      .insert(s.bots)
      .values({
        tenantId,
        name: "Bot",
        kbIds: [kb!.id],
        llmConfigId: llm!.id,
        publicKey: `pk_test_${suffix}${label}`,
      })
      .returning();
    const [conv] = await tx.insert(s.conversations).values({ tenantId, botId: bot!.id }).returning();
    await tx.insert(s.messages).values({ tenantId, conversationId: conv!.id, role: "user", content: "hi" });
    await tx
      .insert(s.usageEvents)
      .values({ tenantId, botId: bot!.id, kind: "chat", provider: "openai", model: "m" });
    await tx.insert(s.auditLog).values({ tenantId, actorId: userId, action: "seed" });
    await tx.insert(s.invitations).values({
      tenantId,
      email: `invitee-${suffix}@example.test`,
      role: "viewer",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: userId,
    });

    return {
      tenantId,
      userId,
      secretId: secret!.id,
      embeddingConfigId: emb!.id,
      llmConfigId: llm!.id,
      vectorStoreId: vs!.id,
      kbId: kb!.id,
      sourceId: source!.id,
      documentId: doc!.id,
      chunkId: chunk!.id,
      botId: bot!.id,
      conversationId: conv!.id,
    };
  });
}
