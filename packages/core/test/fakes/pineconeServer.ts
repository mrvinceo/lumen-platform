import type { Recorded } from "../fakeFetch.js";

interface Rec {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

const cos = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

function matches(
  meta: Record<string, unknown>,
  filter?: Record<string, { $in?: unknown[]; $eq?: unknown }>,
): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, cond]) => {
    if (cond.$in) return cond.$in.includes(meta[k]);
    if ("$eq" in cond) return meta[k] === cond.$eq;
    return true;
  });
}

/**
 * In-memory imitation of Pinecone's REST API (control plane describe + data plane upsert/query/delete), enough
 * for the official SDK to run against. Unknown routes are recorded in `unknown` to make SDK changes obvious.
 */
export function fakePinecone(opts: { apiKey: string; index: string; dimension: number; metric?: string }) {
  const namespaces = new Map<string, Map<string, Rec>>();
  const unknown: string[] = [];
  const host = `${opts.index}-abc123.svc.test.pinecone.io`;
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  const ns = (name?: string) => {
    const key = name ?? "";
    if (!namespaces.has(key)) namespaces.set(key, new Map());
    return namespaces.get(key)!;
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (req.headers.get("api-key") !== opts.apiKey)
      return json({ error: { code: "UNAUTHENTICATED", message: "Invalid API Key" } }, 401);
    const body =
      req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    const rec: Recorded = { method: req.method, url: req.url, headers: {}, body };

    if (url.hostname === "api.pinecone.io" && url.pathname === `/indexes/${opts.index}`) {
      // Current Pinecone API shape: vector settings live in schema.fields; the SDK derives dimension/metric.
      return json({
        name: opts.index,
        host,
        deployment: { deployment_type: "managed", cloud: "aws", region: "us-east-1" },
        schema: {
          fields: {
            _values: { type: "dense_vector", dimension: opts.dimension, metric: opts.metric ?? "cosine" },
          },
        },
        deletion_protection: "disabled",
        status: { ready: true, state: "Ready" },
      });
    }
    if (url.hostname === "api.pinecone.io" && url.pathname.startsWith("/indexes/")) {
      return json({ error: { code: "NOT_FOUND", message: "Index not found" } }, 404);
    }
    if (url.hostname === host) {
      if (url.pathname === "/vectors/upsert") {
        const n = ns(body.namespace as string);
        for (const v of body.vectors as Rec[]) n.set(v.id, v);
        return json({ upsertedCount: (body.vectors as Rec[]).length });
      }
      if (url.pathname === "/query") {
        const n = ns(body.namespace as string);
        const q = body.vector as number[];
        const res = [...n.values()]
          .filter((r) => matches(r.metadata, body.filter as never))
          .map((r) => ({ id: r.id, score: cos(q, r.values), metadata: r.metadata }))
          .sort((a, b) => b.score - a.score)
          .slice(0, body.topK as number);
        return json({ matches: res, namespace: body.namespace ?? "", usage: { readUnits: 1 } });
      }
      if (url.pathname === "/vectors/delete") {
        const n = ns(body.namespace as string);
        if (body.deleteAll) n.clear();
        else if (body.ids) for (const id of body.ids as string[]) n.delete(id);
        else if (body.filter)
          for (const [id, r] of n) if (matches(r.metadata, body.filter as never)) n.delete(id);
        return json({});
      }
    }
    unknown.push(`${rec.method} ${rec.url}`);
    return json({ error: { message: `fake: unknown route ${rec.method} ${url.pathname}` } }, 404);
  }) as typeof fetch;

  return { fetch: fetchImpl, unknown, namespaces };
}
