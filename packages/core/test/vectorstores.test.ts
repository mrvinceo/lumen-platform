import { randomUUID } from "node:crypto";
import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it } from "vitest";
import {
  firestoreIndexCommand,
  firestoreVectorStore,
  type KbRef,
  pineconeVectorStore,
} from "../src/index.js";
import { vectorStoreContract } from "./contracts/vectorStore.contract.js";
import { fakeFirestore } from "./fakes/firestore.js";
import { fakePinecone } from "./fakes/pineconeServer.js";

const kbRef = (dimension = 8): KbRef => {
  const kbId = randomUUID();
  return { tenantId: randomUUID(), kbId, namespace: `kb_${kbId}`, dimension };
};

const pc = fakePinecone({ apiKey: "pc-test-key-123456", index: "lumen", dimension: 8 });
vectorStoreContract("pinecone (fake API)", async () => ({
  store: pineconeVectorStore({ apiKey: "pc-test-key-123456", indexName: "lumen", fetch: pc.fetch }),
  kb: async () => kbRef(),
}));

vectorStoreContract("firestore (in-memory double)", async () => ({
  store: firestoreVectorStore({
    serviceAccountJson: "",
    client: fakeFirestore().client as unknown as Firestore,
  }),
  kb: async () => kbRef(),
}));

describe("Pinecone specifics", () => {
  it("only uses Pinecone routes the fake implements", () => {
    expect(pc.unknown).toEqual([]);
  });

  it("refuses an index whose dimension does not match", async () => {
    const store = pineconeVectorStore({ apiKey: "pc-test-key-123456", indexName: "lumen", fetch: pc.fetch });
    const h = await store.healthcheck({ dimension: 1536 });
    expect(h.ok).toBe(false);
    expect(h.message).toMatch(/8 dimensions .* 1536/);
    await expect(store.ensureIndex(kbRef(1536))).rejects.toThrow(/1536/);
  });

  it("refuses non-cosine indexes", async () => {
    const dot = fakePinecone({ apiKey: "k-0123456789", index: "dot", dimension: 8, metric: "dotproduct" });
    const h = await pineconeVectorStore({
      apiKey: "k-0123456789",
      indexName: "dot",
      fetch: dot.fetch,
    }).healthcheck();
    expect(h).toMatchObject({ ok: false });
    expect(h.message).toContain("cosine");
  });

  it("reports a bad key as an auth failure", async () => {
    const h = await pineconeVectorStore({
      apiKey: "wrong-key-0123456",
      indexName: "lumen",
      fetch: pc.fetch,
    }).healthcheck();
    expect(h.ok).toBe(false);
    expect(h.message).toMatch(/API key was rejected/);
  });

  it("reports a missing index", async () => {
    const h = await pineconeVectorStore({
      apiKey: "pc-test-key-123456",
      indexName: "nope",
      fetch: pc.fetch,
    }).healthcheck();
    expect(h.ok).toBe(false);
  });
});

describe("Firestore specifics", () => {
  it("validates the service account JSON", () => {
    expect(() => firestoreVectorStore({ serviceAccountJson: "{not json" })).toThrow(/not valid JSON/);
    expect(() => firestoreVectorStore({ serviceAccountJson: "{}" })).toThrow(/project_id/);
  });

  it("enforces the 2048-dimension limit", async () => {
    const store = firestoreVectorStore({
      serviceAccountJson: "",
      client: fakeFirestore().client as unknown as Firestore,
    });
    await expect(store.ensureIndex(kbRef(3072))).rejects.toThrow(/2048/);
    expect((await store.healthcheck({ dimension: 3072 })).ok).toBe(false);
  });

  it("explains how to create the missing vector index", async () => {
    const { client } = fakeFirestore();
    const failing = {
      ...client,
      collection: () => ({
        where: () => ({
          findNearest: () => ({
            get: async () => {
              throw Object.assign(new Error("FAILED_PRECONDITION: Missing vector index configuration"), {
                code: 9,
              });
            },
          }),
        }),
      }),
    };
    const store = firestoreVectorStore({
      serviceAccountJson: "",
      projectId: "acme",
      client: failing as unknown as Firestore,
    });
    const kb = kbRef(768);
    await expect(store.query(kb, [1], { topK: 1, audiences: ["public"] })).rejects.toMatchObject({
      action: firestoreIndexCommand("acme", `lumen_${kb.namespace}`, 768),
    });
  });

  it("builds a gcloud index command", () => {
    expect(firestoreIndexCommand("acme", "lumen_kb_1", 768)).toBe(
      'gcloud firestore indexes composite create --project=acme --collection-group=lumen_kb_1 --query-scope=COLLECTION --field-config=order=ASCENDING,field-path=audience --field-config=field-path=embedding,vector-config=\'{"dimension":"768","flat":"{}"}\'',
    );
  });
});
