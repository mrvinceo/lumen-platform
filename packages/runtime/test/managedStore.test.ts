import { randomUUID } from "node:crypto";
import { schema, withTenant } from "@lumen/db";
import { afterAll, describe } from "vitest";
import { vectorStoreContract } from "../../core/test/contracts/vectorStore.contract.js";
import { pgvectorManagedStore } from "../src/index.js";
import { DIM, makeTenantKb, makeWorld, type World } from "./setup.js";

let world: World | undefined;
afterAll(async () => {
  await world?.close();
});

describe.skipIf(!process.env.DATABASE_URL)("managed pgvector", () => {
  vectorStoreContract("managed pgvector (Postgres)", async () => {
    world = await makeWorld();
    const w = world;
    const sources = new Map<string, { tenantId: string; sourceId: string }>();
    return {
      store: pgvectorManagedStore(w.deps.db),
      dimension: DIM,
      kb: async () => {
        const t = await makeTenantKb(w);
        sources.set(t.kb.id, { tenantId: t.tenantId, sourceId: t.sourceId });
        return { tenantId: t.tenantId, kbId: t.kb.id, namespace: t.kb.namespace, dimension: DIM };
      },
      // Managed vectors reference chunk rows, so create documents and chunks first (as the pipeline does).
      prepare: async (kb, items) => {
        const s = sources.get(kb.kbId)!;
        await withTenant(w.deps.db, kb.tenantId, async (tx) => {
          for (const docId of new Set(items.map((i) => i.metadata.documentId))) {
            await tx
              .insert(schema.documents)
              .values({
                id: docId,
                tenantId: kb.tenantId,
                kbId: kb.kbId,
                sourceId: s.sourceId,
                externalId: docId,
                title: "t",
              })
              .onConflictDoNothing();
          }
          for (const it of items) {
            await tx
              .insert(schema.chunks)
              .values({
                id: it.id,
                tenantId: kb.tenantId,
                kbId: kb.kbId,
                documentId: it.metadata.documentId,
                ordinal: Number.parseInt(randomUUID().slice(0, 6), 16),
                text: "x",
                tokenCount: 1,
                contentHash: "h",
                audience: it.metadata.audience,
              })
              .onConflictDoNothing();
          }
        });
      },
    };
  });
});
