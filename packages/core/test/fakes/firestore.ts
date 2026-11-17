/**
 * Minimal in-memory stand-in for the parts of @google-cloud/firestore the adapter uses: collection/doc refs,
 * where(==/in), limit, findNearest (cosine), batches, recursiveDelete, listCollections.
 */
type Data = Record<string, unknown>;
type Filter = { field: string; op: "==" | "in"; value: unknown };

const valuesOf = (v: unknown): number[] => {
  const x = v as { toArray?: () => number[]; _values?: number[] };
  return x?.toArray?.() ?? x?._values ?? (v as number[]);
};

const cosineDistance = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

export function fakeFirestore() {
  const store = new Map<string, Map<string, Data>>();
  const coll = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };

  const docRef = (c: string, id: string) => ({ id, path: `${c}/${id}`, _c: c });
  const snapshot = (docs: { id: string; data: Data; c: string }[]) => ({
    empty: docs.length === 0,
    docs: docs.map((d) => ({
      id: d.id,
      ref: docRef(d.c, d.id),
      get: (f: string) => d.data[f],
      data: () => d.data,
    })),
  });

  const query = (c: string, filters: Filter[] = [], lim?: number): unknown => ({
    where: (field: string, op: "==" | "in", value: unknown) =>
      query(c, [...filters, { field, op, value }], lim),
    limit: (n: number) => query(c, filters, n),
    get: async () => {
      let rows = [...coll(c)].map(([id, data]) => ({ id, data, c }));
      rows = rows.filter((r) =>
        filters.every((f) =>
          f.op === "==" ? r.data[f.field] === f.value : (f.value as unknown[]).includes(r.data[f.field]),
        ),
      );
      return snapshot(lim ? rows.slice(0, lim) : rows);
    },
    findNearest: (o: {
      vectorField: string;
      queryVector: number[];
      limit: number;
      distanceResultField: string;
    }) => ({
      get: async () => {
        const rows = [...coll(c)]
          .map(([id, data]) => ({ id, data, c }))
          .filter((r) =>
            filters.every((f) =>
              f.op === "==" ? r.data[f.field] === f.value : (f.value as unknown[]).includes(r.data[f.field]),
            ),
          )
          .map((r) => ({
            ...r,
            data: {
              ...r.data,
              [o.distanceResultField]: cosineDistance(o.queryVector, valuesOf(r.data[o.vectorField])),
            },
          }))
          .sort(
            (a, b) => (a.data[o.distanceResultField] as number) - (b.data[o.distanceResultField] as number),
          )
          .slice(0, o.limit);
        return snapshot(rows);
      },
    }),
  });

  const client = {
    collection: (name: string) => ({
      ...(query(name) as object),
      _c: name,
      doc: (id: string) => docRef(name, id),
    }),
    batch: () => {
      const ops: (() => void)[] = [];
      return {
        set: (ref: { _c: string; id: string }, data: Data) => ops.push(() => coll(ref._c).set(ref.id, data)),
        delete: (ref: { _c: string; id: string }) => ops.push(() => coll(ref._c).delete(ref.id)),
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    recursiveDelete: async (ref: { _c: string }) => void store.delete(ref._c),
    listCollections: async () => [...store.keys()],
  };
  return { client, store };
}
