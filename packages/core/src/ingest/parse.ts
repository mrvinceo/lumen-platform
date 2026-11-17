import { convert as htmlToText } from "html-to-text";
import mammoth from "mammoth";
import { OfficeParser } from "officeparser";
import { PDFParse } from "pdf-parse";

/** A slice of a document with its structural context, used by the chunker for citations. */
export interface Section {
  /** Heading trail, e.g. ["Refunds", "Digital products"]. */
  headings: string[];
  /** 1-based page number (PDF) or slide number (PPTX), when known. */
  page?: number;
  text: string;
}

export interface ParsedDocument {
  format: DocumentFormat;
  title?: string;
  sections: Section[];
  charCount: number;
}

export type DocumentFormat = "pdf" | "docx" | "pptx" | "xlsx" | "odf" | "csv" | "markdown" | "html" | "text";

export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_CHARS = 5_000_000;

export class ParseError extends Error {
  constructor(
    readonly code: "too_large" | "unsupported" | "empty" | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

const EXT: Record<string, DocumentFormat> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  odt: "odf",
  odp: "odf",
  ods: "odf",
  csv: "csv",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  txt: "text",
  text: "text",
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT);

/**
 * Decides the format from the file's own bytes first and the name/MIME type second, so a renamed file can't
 * smuggle one format through another format's parser.
 */
export function detectFormat(bytes: Uint8Array, filename: string, mimeType?: string): DocumentFormat {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byName = EXT[ext];
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (isZip) {
    if (byName === "docx" || byName === "pptx" || byName === "xlsx" || byName === "odf") return byName;
    if (mimeType?.includes("wordprocessingml")) return "docx";
    if (mimeType?.includes("presentationml")) return "pptx";
    if (mimeType?.includes("spreadsheetml")) return "xlsx";
    throw new ParseError("unsupported", "This archive is not a supported document type.");
  }
  if (byName === "pdf" || byName === "docx" || byName === "pptx" || byName === "xlsx" || byName === "odf") {
    throw new ParseError(
      "corrupt",
      `The file is named .${ext} but its contents are not a valid ${ext.toUpperCase()} file.`,
    );
  }
  if (looksBinary(bytes)) throw new ParseError("unsupported", "Unsupported file type.");
  if (byName) return byName;
  if (mimeType === "text/html") return "html";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/csv") return "csv";
  return "text";
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  let nul = 0;
  for (const b of sample) if (b === 0) nul++;
  return nul > 0;
}

export async function parseDocument(
  bytes: Uint8Array,
  filename: string,
  mimeType?: string,
): Promise<ParsedDocument> {
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new ParseError("too_large", `Files must be under ${MAX_INPUT_BYTES / 1024 / 1024} MB.`);
  }
  const format = detectFormat(bytes, filename, mimeType);
  let sections: Section[];
  try {
    sections = await parseByFormat(format, bytes);
  } catch (err) {
    if (err instanceof ParseError) throw err;
    throw new ParseError(
      "corrupt",
      `Could not read this ${format.toUpperCase()} file: ${(err as Error).message}`,
    );
  }
  sections = sections
    .map((s) => ({ ...s, text: normaliseWhitespace(s.text) }))
    .filter((s) => s.text.length > 0);
  let charCount = sections.reduce((n, s) => n + s.text.length, 0);
  if (charCount === 0) {
    throw new ParseError(
      "empty",
      format === "pdf"
        ? "No extractable text. This looks like a scanned PDF; OCR is not supported yet."
        : "The document contains no text.",
    );
  }
  if (charCount > MAX_TEXT_CHARS) {
    const kept: Section[] = [];
    let total = 0;
    for (const s of sections) {
      if (total >= MAX_TEXT_CHARS) break;
      const text = s.text.slice(0, MAX_TEXT_CHARS - total);
      kept.push({ ...s, text });
      total += text.length;
    }
    sections = kept;
    charCount = total;
  }
  const title = sections.find((s) => s.headings.length > 0)?.headings[0];
  return { format, title, sections, charCount };
}

async function parseByFormat(format: DocumentFormat, bytes: Uint8Array): Promise<Section[]> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (format) {
    case "pdf":
      return parsePdf(buf);
    case "docx": {
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      return htmlSections(value);
    }
    case "pptx":
    case "xlsx":
    case "odf": {
      const ast = await OfficeParser.parseOffice(buf);
      const text = String((await ast.to("text")).value ?? "");
      return paragraphsAsSection(text);
    }
    case "html":
      return htmlSections(buf.toString("utf8"));
    case "markdown":
      return markdownSections(buf.toString("utf8"));
    case "csv":
      return csvSections(buf.toString("utf8"));
    case "text":
      return paragraphsAsSection(buf.toString("utf8"));
  }
}

async function parsePdf(buf: Buffer): Promise<Section[]> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.pages.map((p) => ({ headings: [], page: p.num, text: p.text }));
  } finally {
    await parser.destroy();
  }
}

function paragraphsAsSection(text: string): Section[] {
  return [{ headings: [], text }];
}

/** Markdown: split on ATX headings, tracking the heading trail. */
export function markdownSections(md: string): Section[] {
  const sections: Section[] = [];
  const trail: string[] = [];
  let buffer: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) sections.push({ headings: [...trail], text });
    buffer = [];
  };
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m?.[1] && m[2]) {
      flush();
      const level = m[1].length;
      trail.length = level - 1;
      trail[level - 1] = m[2];
      // Fill gaps (e.g. "#" then "###") so the trail has no holes.
      for (let i = 0; i < trail.length; i++) trail[i] ??= "";
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections.map((s) => ({ ...s, headings: s.headings.filter(Boolean) }));
}

/** HTML (also DOCX via mammoth): split on h1–h6 and convert each part to plain text. */
export function htmlSections(html: string): Section[] {
  const parts = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/i);
  const sections: Section[] = [];
  const trail: string[] = [];
  for (const part of parts) {
    const h = /^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>$/i.exec(part.trim());
    if (h?.[1] && h[2] !== undefined) {
      const level = Number(h[1]);
      trail.length = level - 1;
      trail[level - 1] = htmlToText(h[2], { wordwrap: false }).trim();
      continue;
    }
    const text = htmlToText(part, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
        { selector: "script", format: "skip" },
        { selector: "style", format: "skip" },
      ],
    });
    if (text.trim()) sections.push({ headings: trail.filter(Boolean), text });
  }
  return sections;
}

/** CSV: keep the header with every block of rows so each chunk is self-describing. */
export function csvSections(csv: string): Section[] {
  const lines = csv
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  const [header, ...rows] = lines;
  if (!header) return [];
  const sections: Section[] = [];
  const ROWS = 40;
  for (let i = 0; i < rows.length; i += ROWS) {
    sections.push({ headings: [], text: [header, ...rows.slice(i, i + ROWS)].join("\n") });
  }
  return sections.length ? sections : [{ headings: [], text: header }];
}

function normaliseWhitespace(text: string): string {
  return text
    .replaceAll("\0", "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
