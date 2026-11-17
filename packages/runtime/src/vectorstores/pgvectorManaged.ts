import {
  type Audience,
  type KbRef,
  scoreFromCosineDistance,
  timed,
  type VectorMatch,
  type VectorStore,
  VectorStoreError,
} from "@lumen/core";
import { type Database, MANAGED_DIMENSIONS, type ManagedDimension, sql, withTenant } from "@lumen/db";

const isManaged = (d: number): d is ManagedDimension => (MANAGED_DIMENSIONS as readonly number[]).includes(d);

function table(dim: number) {
  if (!isManaged(dim))
    throw new VectorStoreError(`The managed store supports ${MANAGED_DIMENSIONS.join(", ")} dimensions.`);
  return {
    name: sql.identifier(`embeddings_${dim}`),
    cast: sql.raw(dim > 2000 ? `halfvec(${dim})` : `vector(${dim})`),
  };
}

const literal = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

/**
 * The platform-managed store: pgvector tables in Lumen's own Postgres, one per dimension, with HNSW indexes.
 * Every statement runs through withTenant(), so row-level security applies on top of the kb_id filter.
 * Rows reference `chunks` (cascade delete), so chunk rows must exist before their vectors are written.
 */
export function pgvectorManagedStore(db: Database): VectorStore {
  return {
    provider: "pgvector_managed",

    ensureIndex: async (kb) => void table(kb.dimension),

    upsert: async (kb, items) => {
      if (items.length === 0) return;
      const t = table(kb.dimension);
      await withTenant(db, kb.tenantId, async (tx) => {
        for (let i = 0; i < items.length; i += 200) {
          const rows = items
            .slice(i, i + 200)
            .map(
              (it) =>
                sql`(${it.id}::uuid, ${kb.tenantId}::uuid, ${kb.kbId}::uuid, ${it.metadata.audience}::audience, ${literal(it.vector)}::${t.cast})`,
            );
          await tx.execute(sql`
            insert into ${t.name} (chunk_id, tenant_id, kb_id, audience, embedding)
            values ${sql.join(rows, sql`, `)}
            on conflict (chunk_id) do update set embedding = excluded.embedding, audience = excluded.audience`);
        }
      });
    },

    query: async (kb, vector, opts) => {
      const t = table(kb.dimension);
      const audiences = sql.join(
        opts.audiences.map((a: Audience) => sql`${a}::audience`),
        sql`, `,
      );
      const rows = await withTenant(db, kb.tenantId, async (tx) => {
        // Higher ef_search keeps recall good when the audience filter removes many HNSW candidates.
        await tx.execute(sql`set local hnsw.ef_search = 100`);
        return tx.execute<{ chunk_id: string; document_id: string; distance: number }>(sql`
          select e.chunk_id, c.document_id, e.embedding <=> ${literal(vector)}::${t.cast} as distance
          from ${t.name} e join chunks c on c.id = e.chunk_id
          where e.kb_id = ${kb.kbId} and e.audience in (${audiences})
          order by e.embedding <=> ${literal(vector)}::${t.cast}
          limit ${opts.topK}`);
      });
      return rows.map(
        (r): VectorMatch => ({
          id: r.chunk_id,
          documentId: r.document_id,
          score: scoreFromCosineDistance(Number(r.distance)),
        }),
      );
    },

    deleteIds: async (kb, ids) => {
      if (ids.length === 0) return;
      const t = table(kb.dimension);
      await withTenant(db, kb.tenantId, (tx) =>
        tx.execute(
          sql`delete from ${t.name} where kb_id = ${kb.kbId} and chunk_id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ),
      );
    },

    deleteByDocument: async (kb, documentId) => {
      const t = table(kb.dimension);
      await withTenant(db, kb.tenantId, (tx) =>
        tx.execute(
          sql`delete from ${t.name} where kb_id = ${kb.kbId} and chunk_id in (select id from chunks where document_id = ${documentId})`,
        ),
      );
    },

    deleteNamespace: async (kb: KbRef) => {
      const t = table(kb.dimension);
      await withTenant(db, kb.tenantId, (tx) =>
        tx.execute(sql`delete from ${t.name} where kb_id = ${kb.kbId}`),
      );
    },

    healthcheck: (expect) =>
      timed(async () => {
        if (expect?.dimension) table(expect.dimension);
        await db.execute(sql`select 1`);
        return { message: "Lumen managed store (Postgres + pgvector) is available." };
      }),
  };
}
