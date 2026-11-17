import { createHash } from "node:crypto";
import type { Section } from "./parse.js";

export interface Chunk {
  ordinal: number;
  text: string;
  tokenCount: number;
  contentHash: string;
  headings: string[];
  page?: number;
}

export interface ChunkOptions {
  /** Target chunk size in (estimated) tokens. */
  targetTokens?: number;
  /** Tokens carried over from the end of one chunk to the start of the next. */
  overlapTokens?: number;
}

/** Roughly 4 characters per token for English prose; close enough for sizing chunks. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Splits sections into overlapping chunks. Section boundaries (headings, pages) are never crossed, so every
 * chunk has one heading trail and page for citations. Within a section, text is split on paragraphs, then
 * sentences, then words, keeping pieces as large as possible up to the target size.
 */
export function chunkSections(sections: Section[], opts: ChunkOptions = {}): Chunk[] {
  const target = opts.targetTokens ?? 600;
  const overlap = Math.min(opts.overlapTokens ?? 90, Math.floor(target / 3));
  const maxChars = target * 4;
  const overlapChars = overlap * 4;
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const pieces = splitToFit(section.text, maxChars);
    let current = "";
    const emit = () => {
      const body = current.trim();
      if (!body) return;
      const prefix = section.headings.length ? `${section.headings.join(" › ")}\n\n` : "";
      const text = prefix + body;
      chunks.push({
        ordinal: chunks.length,
        text,
        tokenCount: estimateTokens(text),
        contentHash: sha256(text),
        headings: section.headings,
        page: section.page,
      });
    };
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > maxChars) {
        emit();
        // Carry overlap forward, but never so much that the next chunk exceeds the limit.
        current = tail(current, Math.min(overlapChars, maxChars - piece.length - 1));
      }
      current = current ? `${current}\n${piece}` : piece;
    }
    emit();
  }
  return chunks;
}

/** Breaks text into pieces no longer than maxChars, preferring paragraph, then sentence, then word breaks. */
function splitToFit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    if (para.length <= maxChars) {
      out.push(para);
      continue;
    }
    const sentences = para.match(/[^.!?\n]+[.!?]*[\])'"]*\s*|\n/g) ?? [para];
    let buf = "";
    for (const s of sentences) {
      if (s.length > maxChars) {
        if (buf) out.push(buf.trim());
        buf = "";
        out.push(...hardWrap(s, maxChars));
        continue;
      }
      if (buf.length + s.length > maxChars) {
        out.push(buf.trim());
        buf = "";
      }
      buf += s;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter(Boolean);
}

function hardWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word.length > maxChars) {
      if (line) out.push(line);
      line = "";
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    if (line.length + word.length + 1 > maxChars) {
      out.push(line);
      line = "";
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** The last ~n characters of text, starting at a word boundary. */
function tail(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return n <= 0 ? "" : text;
  const slice = text.slice(-n);
  const space = slice.indexOf(" ");
  return space > 0 ? slice.slice(space + 1) : slice;
}
