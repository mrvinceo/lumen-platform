import { readFileSync } from "node:fs";
import { eq, schema, sql, withTenant } from "@lumen/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deleteDocument,
  deleteKnowledgeBase,
  ingestDocument,
  loadKnowledgeBase,
  type SearchHit,
  searchKnowledgeBase,
} from "../src/index.js";
import { addDocument, makeTenantKb, makeWorld, type World } from "./setup.js";

const POLICY = `# Returns policy

Customers may return unused items within 30 days of delivery for a full refund.

## Shipping

Standard shipping takes three to five working days. Express delivery arrives the next working day.
`;

describe.skipIf(!process.env.DATABASE_URL)("ingestion pipeline", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  const search = async (
    tenantId: string,
    kbId: string,
    query: string,
    audiences: ("public" | "staff")[] = ["public"],
  ) => {
    const loaded = await withTenant(world.deps.db, tenantId, (tx) =>
      loadKnowledgeBase(tx, world.deps, tenantId, kbId),
    );
    const { hits } = await searchKnowledgeBase(loaded, query, { audiences, topK: 5 }, (ids) =>
      withTenant(world.deps.db, tenantId, (tx) =>
        tx
          .select({
            id: schema.chunks.id,
            text: schema.chunks.text,
            metadata: schema.chunks.metadata,
            audience: schema.chunks.audience,
            documentId: schema.chunks.documentId,
            title: schema.documents.title,
          })
          .from(schema.chunks)
          .innerJoin(schema.documents, eq(schema.documents.id, schema.chunks.documentId))
          .where(
            sql`${schema.chunks.id} in (${sql.join(
              ids.map((i) => sql`${i}::uuid`),
              sql`, `,
            )})`,
          ),
      ),
    );
    return hits;
  };

  it("indexes a Markdown document and finds the right passage", async () => {
    const t = await makeTenantKb(world);
    const docId = await addDocument(world, t, "policy.md", POLICY);
    const res = await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
    expect(res).toMatchObject({ status: "indexed", chunks: 2, embedded: 2 });

    const [doc] = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.select().from(schema.documents).where(eq(schema.documents.id, docId)),
    );
    expect(doc).toMatchObject({ status: "indexed", chunkCount: 2, error: null });

    const hits: SearchHit[] = await search(
      t.tenantId,
      t.kb.id,
      "How long does express shipping delivery take?",
    );
    expect(hits[0]?.headings).toEqual(["Returns policy", "Shipping"]);
    expect(hits[0]?.text).toContain("Express delivery");
    expect(hits[0]?.documentTitle).toBe("policy.md");

    const usage = await withTenant(world.deps.db, t.tenantId, (tx) => tx.select().from(schema.usageEvents));
    expect(usage[0]).toMatchObject({ kind: "embedding_ingest" });
  });

  it("indexes DOCX and PDF files", async () => {
    const t = await makeTenantKb(world);
    const fixture = (n: string) =>
      new Uint8Array(readFileSync(new URL(`../../core/test/fixtures/${n}`, import.meta.url)));
    const docx = await addDocument(world, t, "policy.docx", fixture("policy.docx"));
    const pdf = await addDocument(world, t, "handbook.pdf", fixture("handbook.pdf"));
    expect((await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docx })).status).toBe(
      "indexed",
    );
    expect((await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: pdf })).status).toBe(
      "indexed",
    );
    const hits = await search(t.tenantId, t.kb.id, "annual leave requests HR portal");
    expect(hits[0]).toMatchObject({ documentTitle: "handbook.pdf", page: 2 });
  });

  it("skips unchanged documents and re-embeds only changed chunks", async () => {
    const t = await makeTenantKb(world);
    const docId = await addDocument(world, t, "policy.md", POLICY);
    await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
    const before = world.embedder.calls.length;

    expect((await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId })).status).toBe(
      "unchanged",
    );
    expect(world.embedder.calls.length).toBe(before);

    const [doc] = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.select().from(schema.documents).where(eq(schema.documents.id, docId)),
    );
    await world.deps.objects.put(
      doc!.storageKey!,
      new TextEncoder().encode(POLICY.replace("three to five", "two to four")),
    );
    const res = await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
    expect(res).toMatchObject({ status: "indexed", chunks: 2, embedded: 1 });

    const rows = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from embeddings_768 where kb_id = ${t.kb.id}`),
    );
    expect(rows[0]?.n).toBe(2);
    const hits = await search(t.tenantId, t.kb.id, "standard shipping working days");
    expect(hits[0]?.text).toContain("two to four");
  });

  it("keeps staff-only documents out of public searches", async () => {
    const t = await makeTenantKb(world);
    const staff = await addDocument(
      world,
      t,
      "salaries.md",
      "# Pay bands\n\nSenior engineers earn band seven salaries.",
      "staff",
    );
    await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: staff });
    expect(await search(t.tenantId, t.kb.id, "senior engineers salary band")).toEqual([]);
    const staffHits = await search(t.tenantId, t.kb.id, "senior engineers salary band", ["public", "staff"]);
    expect(staffHits[0]?.documentId).toBe(staff);
  });

  it("never returns another tenant's chunks", async () => {
    const a = await makeTenantKb(world);
    const b = await makeTenantKb(world);
    const docA = await addDocument(world, a, "policy.md", POLICY);
    await ingestDocument(world.deps, { tenantId: a.tenantId, documentId: docA });
    await expect(search(b.tenantId, a.kb.id, "express shipping")).rejects.toThrow(/not found/i);
    expect(await search(b.tenantId, b.kb.id, "express shipping")).toEqual([]);
  });

  it("records provider failures on the document with a readable message", async () => {
    const t = await makeTenantKb(world);
    const docId = await addDocument(world, t, "policy.md", POLICY);
    world.embedder.failWith = 401;
    try {
      const res = await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
      expect(res).toMatchObject({ status: "error", retryable: false });
      expect(res.error).toMatch(/API key was rejected/);
    } finally {
      world.embedder.failWith = undefined;
    }
    const [doc] = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.select().from(schema.documents).where(eq(schema.documents.id, docId)),
    );
    expect(doc?.status).toBe("error");
    expect(doc?.error).toMatch(/API key was rejected/);
  });

  it("records unreadable files without retrying", async () => {
    const t = await makeTenantKb(world);
    const docId = await addDocument(world, t, "broken.pdf", "this is not a pdf");
    const res = await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
    expect(res).toMatchObject({ status: "error", retryable: false });
    expect(res.error).toMatch(/not a valid PDF/);
  });

  it("deletes a document's vectors, chunks and file", async () => {
    const t = await makeTenantKb(world);
    const docId = await addDocument(world, t, "policy.md", POLICY);
    await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
    const [doc] = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.select().from(schema.documents).where(eq(schema.documents.id, docId)),
    );
    await deleteDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
    expect(await search(t.tenantId, t.kb.id, "express shipping")).toEqual([]);
    await expect(world.deps.objects.get(doc!.storageKey!)).rejects.toThrow();
    const left = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from chunks where document_id = ${docId}`),
    );
    expect(left[0]?.n).toBe(0);
  });

  it("deletes a whole knowledge base", async () => {
    const t = await makeTenantKb(world);
    const docId = await addDocument(world, t, "policy.md", POLICY);
    await ingestDocument(world.deps, { tenantId: t.tenantId, documentId: docId });
    await deleteKnowledgeBase(world.deps, { tenantId: t.tenantId, kbId: t.kb.id });
    const counts = await withTenant(world.deps.db, t.tenantId, (tx) =>
      tx.execute<{ kbs: number; vecs: number }>(sql`select
        (select count(*)::int from knowledge_bases where id = ${t.kb.id}) as kbs,
        (select count(*)::int from embeddings_768 where kb_id = ${t.kb.id}) as vecs`),
    );
    expect(counts[0]).toEqual({ kbs: 0, vecs: 0 });
  });
});
