import type { Audience, EmbeddingModel } from "@lumen/core";
import { and, inArray, ne, schema, sql, withTenant } from "@lumen/db";
import { type LoadedKnowledgeBase, loadKnowledgeBase, type RuntimeDeps } from "./resolve.js";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  kbId: string;
  title: string;
  headings: string[];
  page?: number;
  text: string;
  audience: Audience;
  /** Vector similarity in [0, 1] when the chunk came from vector search, otherwise 0. */
  score: number;
  /** Reciprocal-rank-fusion score used for ordering. */
  rrf: number;
  via: ("vector" | "keyword")[];
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  skipped: { kbId: string; reason: string }[];
  /** Query-embedding usage per embedding model, for metering. */
  embedUsage: { provider: string; model: string; tokens: number }[];
}

const RRF_K = 60;

const STOP_WORDS = new Set(
  "is of to in on at by or an as be it if no so do up we me my the and for are but not you all any can had her was one our out has his how its may new now see two way who did get let put say she too use what when where which while with your this that from have will would there their about into than them then they were been more some such only also just like does".split(
    " ",
  ),
);

/** OR-query of the meaningful words, so a passage matching some terms still ranks (websearch syntax is AND). */
export function keywordQuery(text: string): string | undefined {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (w) => w.length >= 2 && !STOP_WORDS.has(w),
  );
  return words.length ? words.slice(0, 24).join(" | ") : undefined;
}

/**
 * Hybrid retrieval across a bot's knowledge bases: vector search in each KB (with that KB's own embedding model)
 * plus Postgres full-text search, merged with reciprocal rank fusion. Exact terms such as product codes, which
 * embeddings often miss, are found by the keyword leg. A KB that is deleted or failing is skipped, not fatal.
 */
export async function retrieve(
  deps: RuntimeDeps,
  input: { tenantId: string; kbIds: string[]; query: string; audiences: Audience[]; topK: number },
): Promise<RetrieveResult> {
  const { tenantId, query, audiences, topK } = input;
  const skipped: RetrieveResult["skipped"] = [];
  const embedUsage: RetrieveResult["embedUsage"] = [];
  if (input.kbIds.length === 0 || !query.trim()) return { chunks: [], skipped, embedUsage };

  // 1. Load the bot's live knowledge bases (with decrypted credentials) in one tenant transaction.
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const kbs = await tx
      .select({ id: schema.knowledgeBases.id })
      .from(schema.knowledgeBases)
      .where(
        and(inArray(schema.knowledgeBases.id, input.kbIds), ne(schema.knowledgeBases.status, "disabled")),
      );
    const live = new Set(kbs.map((k) => k.id));
    for (const id of input.kbIds)
      if (!live.has(id)) skipped.push({ kbId: id, reason: "Knowledge base no longer exists." });
    const out: LoadedKnowledgeBase[] = [];
    for (const k of kbs) {
      try {
        out.push(await loadKnowledgeBase(tx, deps, tenantId, k.id));
      } catch (err) {
        skipped.push({ kbId: k.id, reason: (err as Error).message });
      }
    }
    return out;
  });
  const kbIds = loaded.map((l) => l.kb.id);
  if (kbIds.length === 0) return { chunks: [], skipped, embedUsage };

  // 2. Vector leg: embed once per distinct embedding model, query each KB's store in parallel.
  const embeddings = new Map<string, Promise<number[] | undefined>>();
  const embedOnce = (configId: string, model: EmbeddingModel) => {
    if (!embeddings.has(configId)) {
      embeddings.set(
        configId,
        model.embed([query], "query").then((r) => {
          embedUsage.push({ provider: model.provider, model: model.model, tokens: r.tokens });
          return r.vectors[0];
        }),
      );
    }
    return embeddings.get(configId) as Promise<number[] | undefined>;
  };
  const vectorHits = (
    await Promise.all(
      loaded.map(async (l) => {
        try {
          const vector = await embedOnce(l.kb.embeddingConfigId, l.embedder);
          if (!vector) return [];
          const matches = await l.store.query(l.ref, vector, { topK: topK * 3, audiences });
          return matches.map((m) => ({ ...m, kbId: l.kb.id }));
        } catch (err) {
          skipped.push({ kbId: l.kb.id, reason: (err as Error).message });
          return [];
        }
      }),
    )
  )
    .flat()
    .sort((a, b) => b.score - a.score);

  // 3. Keyword leg over the canonical chunk text.
  const tsq = keywordQuery(query);
  const keywordHits = tsq
    ? await withTenant(deps.db, tenantId, (tx) =>
        tx.execute<{ id: string }>(sql`
          select c.id from chunks c, to_tsquery('simple', ${tsq}) q
          where c.kb_id in (${sql.join(
            kbIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
            and c.audience in (${sql.join(
              audiences.map((a) => sql`${a}::audience`),
              sql`, `,
            )})
            and c.tsv @@ q
          order by ts_rank_cd(c.tsv, q) desc
          limit ${topK * 3}`),
      )
    : [];

  // 4. Reciprocal rank fusion.
  const fused = new Map<string, { rrf: number; score: number; via: Set<"vector" | "keyword"> }>();
  vectorHits.forEach((h, rank) => {
    const e = fused.get(h.id) ?? { rrf: 0, score: 0, via: new Set() };
    e.rrf += 1 / (RRF_K + rank + 1);
    e.score = Math.max(e.score, h.score);
    e.via.add("vector");
    fused.set(h.id, e);
  });
  keywordHits.forEach((h, rank) => {
    const e = fused.get(h.id) ?? { rrf: 0, score: 0, via: new Set() };
    e.rrf += 1 / (RRF_K + rank + 1);
    e.via.add("keyword");
    fused.set(h.id, e);
  });
  if (fused.size === 0) return { chunks: [], skipped, embedUsage };

  // 5. Hydrate from Postgres (the source of truth for text and audience) and re-check scope.
  const ids = [...fused.keys()];
  const rows = await withTenant(deps.db, tenantId, (tx) =>
    tx.execute<{
      id: string;
      document_id: string;
      kb_id: string;
      text: string;
      metadata: { headings?: string[]; page?: number };
      audience: Audience;
      title: string;
    }>(sql`
      select c.id, c.document_id, c.kb_id, c.text, c.metadata, c.audience, d.title
      from chunks c join documents d on d.id = c.document_id
      where c.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`),
  );

  const allowedKb = new Set(kbIds);
  const seen = new Map<string, RetrievedChunk>();
  for (const r of rows) {
    if (!allowedKb.has(r.kb_id) || !audiences.includes(r.audience)) continue;
    const f = fused.get(r.id);
    if (!f) continue;
    const chunk: RetrievedChunk = {
      chunkId: r.id,
      documentId: r.document_id,
      kbId: r.kb_id,
      title: r.title,
      headings: r.metadata?.headings ?? [],
      page: r.metadata?.page,
      text: r.text,
      audience: r.audience,
      score: f.score,
      rrf: f.rrf,
      via: [...f.via],
    };
    // Collapse near-duplicates (same passage uploaded twice, or overlapping chunks).
    const key = r.text.toLowerCase().replace(/\s+/g, " ").slice(0, 160);
    const prev = seen.get(key);
    if (!prev || prev.rrf < chunk.rrf) seen.set(key, chunk);
  }
  const chunks = [...seen.values()].sort((a, b) => b.rrf - a.rrf).slice(0, topK);
  return { chunks, skipped, embedUsage };
}
