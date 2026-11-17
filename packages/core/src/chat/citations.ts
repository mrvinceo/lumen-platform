/** Matches [1], [1, 3], [2-4] and [2–4] (en dash). */
const MARKER = /\[(\d{1,3}(?:\s*(?:,|-|–)\s*\d{1,3})*)\]/g;

/** Numbers cited in the answer, in order of first appearance, keeping only those in 1..sourceCount. */
export function citedNumbers(text: string, sourceCount: number): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(MARKER)) {
    for (const part of (m[1] ?? "").split(",")) {
      const [a, b] = part.split(/-|–/).map((x) => Number.parseInt(x.trim(), 10));
      if (a === undefined || Number.isNaN(a)) continue;
      const end = b === undefined || Number.isNaN(b) ? a : b;
      if (end < a || end - a > 20) continue;
      for (let n = a; n <= end; n++) if (n >= 1 && n <= sourceCount) seen.add(n);
    }
  }
  return [...seen];
}

export interface CitableSource {
  index: number;
  chunkId: string;
  documentId: string;
  title: string;
  headings: string[];
  page?: number;
  text: string;
  score: number;
  url?: string;
}

export interface Citation {
  n: number;
  chunkId: string;
  documentId: string;
  title: string;
  headings: string[];
  page?: number;
  url?: string;
  snippet: string;
  score: number;
}

/** Turns the [n] markers in an answer into citation records for the sources that were actually cited. */
export function extractCitations(text: string, sources: CitableSource[]): Citation[] {
  const byIndex = new Map(sources.map((s) => [s.index, s]));
  return citedNumbers(text, sources.length).flatMap((n) => {
    const s = byIndex.get(n);
    if (!s) return [];
    return [
      {
        n,
        chunkId: s.chunkId,
        documentId: s.documentId,
        title: s.title,
        headings: s.headings,
        page: s.page,
        url: s.url,
        snippet: s.text.length > 600 ? `${s.text.slice(0, 600)}…` : s.text,
        score: s.score,
      },
    ];
  });
}
