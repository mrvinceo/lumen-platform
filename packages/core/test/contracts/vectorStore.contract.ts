import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { KbRef, VectorItem, VectorStore } from "../../src/index.js";

export interface ContractTarget {
  store: VectorStore;
  /** A fresh, empty knowledge base. */
  kb: () => Promise<KbRef>;
  /** Creates anything the store needs before vectors can be written (e.g. chunk rows for managed pgvector). */
  prepare?: (kb: KbRef, items: VectorItem[]) => Promise<void>;
  dimension?: number;
}

/** Unit vector pointing mostly along axis `i` (with a little of axis i+1 so neighbours are ordered). */
export function axis(dim: number, i: number, lean = 0): number[] {
  const v = new Array<number>(dim).fill(0);
  v[i % dim] = 1;
  v[(i + 1) % dim] = lean;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/**
 * Behaviour every VectorStore adapter must share. `make` returns a store plus a factory for fresh,
 * empty knowledge-base refs (so tests don't interfere with each other).
 */
export function vectorStoreContract(name: string, make: () => Promise<ContractTarget>) {
  describe(`VectorStore contract: ${name}`, () => {
    let store: VectorStore;
    let newKb: () => Promise<KbRef>;
    let prepare: ContractTarget["prepare"];
    let dim = 8;

    beforeAll(async () => {
      const t = await make();
      store = t.store;
      newKb = t.kb;
      prepare = t.prepare;
      dim = t.dimension ?? 8;
    });

    async function write(kb: KbRef, items: VectorItem[]) {
      await prepare?.(kb, items);
      await store.upsert(kb, items);
    }

    async function seeded() {
      const kb = await newKb();
      await store.ensureIndex(kb);
      const ids = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() };
      const docA = randomUUID();
      const docB = randomUUID();
      await write(kb, [
        { id: ids.a1, vector: axis(dim, 0), metadata: { documentId: docA, audience: "public" } },
        { id: ids.a2, vector: axis(dim, 0, 0.5), metadata: { documentId: docA, audience: "staff" } },
        { id: ids.b1, vector: axis(dim, 3), metadata: { documentId: docB, audience: "public" } },
      ]);
      return { kb, ids, docA, docB };
    }

    it("returns the nearest vectors first with scores in [0, 1]", async () => {
      const { kb, ids, docA } = await seeded();
      const res = await store.query(kb, axis(dim, 0), { topK: 3, audiences: ["public", "staff"] });
      expect(res[0]?.id).toBe(ids.a1);
      expect(res[0]?.score).toBeCloseTo(1, 3);
      expect(res[0]?.documentId).toBe(docA);
      expect(res[1]?.id).toBe(ids.a2);
      for (let i = 1; i < res.length; i++) expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
      for (const r of res) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it("filters by audience", async () => {
      const { kb, ids } = await seeded();
      const res = await store.query(kb, axis(dim, 0, 0.5), { topK: 10, audiences: ["public"] });
      expect(res.map((r) => r.id)).not.toContain(ids.a2);
      expect(res.map((r) => r.id)).toContain(ids.a1);
    });

    it("upserts idempotently", async () => {
      const { kb, ids, docA } = await seeded();
      await write(kb, [
        { id: ids.a1, vector: axis(dim, 0), metadata: { documentId: docA, audience: "public" } },
      ]);
      const res = await store.query(kb, axis(dim, 0), { topK: 10, audiences: ["public", "staff"] });
      expect(res.filter((r) => r.id === ids.a1)).toHaveLength(1);
      expect(res).toHaveLength(3);
    });

    it("keeps knowledge bases apart", async () => {
      await seeded();
      const other = await newKb();
      await store.ensureIndex(other);
      expect(await store.query(other, axis(dim, 0), { topK: 10, audiences: ["public", "staff"] })).toEqual(
        [],
      );
    });

    it("deletes by id, by document and by namespace", async () => {
      const { kb, ids, docA, docB } = await seeded();
      const all = { topK: 10, audiences: ["public", "staff"] as ("public" | "staff")[] };
      await store.deleteIds(kb, [ids.b1]);
      expect((await store.query(kb, axis(dim, 3), all)).map((r) => r.id)).not.toContain(ids.b1);
      await store.deleteByDocument(kb, docA);
      expect(await store.query(kb, axis(dim, 0), all)).toEqual([]);
      await write(kb, [
        { id: ids.b1, vector: axis(dim, 3), metadata: { documentId: docB, audience: "public" } },
      ]);
      await store.deleteNamespace(kb);
      expect(await store.query(kb, axis(dim, 3), all)).toEqual([]);
    });

    it("passes its healthcheck", async () => {
      const h = await store.healthcheck({ dimension: dim });
      expect(h.ok).toBe(true);
    });
  });
}
