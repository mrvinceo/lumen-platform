import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkSections, detectFormat, estimateTokens, ParseError, parseDocument } from "../src/index.js";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const text = (s: string) => new TextEncoder().encode(s);

describe("parseDocument", () => {
  it("reads PDFs page by page", async () => {
    const doc = await parseDocument(fixture("handbook.pdf"), "handbook.pdf");
    expect(doc.format).toBe("pdf");
    expect(doc.sections.map((s) => s.page)).toEqual([1, 2]);
    expect(doc.sections[1]?.text).toContain("HR portal");
  });

  it("reads DOCX with its heading structure", async () => {
    const doc = await parseDocument(fixture("policy.docx"), "policy.docx");
    expect(doc.format).toBe("docx");
    expect(doc.title).toBe("Returns Policy");
    const digital = doc.sections.find((s) => s.text.includes("Software licences"));
    expect(digital?.headings).toEqual(["Returns Policy", "Digital products"]);
  });

  it("reads PPTX", async () => {
    const doc = await parseDocument(fixture("update.pptx"), "update.pptx");
    expect(doc.format).toBe("pptx");
    expect(doc.sections.map((s) => s.text).join(" ")).toContain("Revenue grew 12 percent");
  });

  it("reads Markdown with a heading trail, ignoring # inside code fences", async () => {
    const md = "# Guide\nIntro.\n## Setup\nRun it.\n```sh\n# not a heading\n```\n### Linux\nUse apt.\n";
    const doc = await parseDocument(text(md), "guide.md");
    expect(doc.sections.map((s) => s.headings)).toEqual([
      ["Guide"],
      ["Guide", "Setup"],
      ["Guide", "Setup", "Linux"],
    ]);
    expect(doc.sections[1]?.text).toContain("# not a heading");
  });

  it("reads HTML without scripts", async () => {
    const doc = await parseDocument(
      text("<h1>FAQ</h1><p>Answer <b>here</b>.</p><script>alert(1)</script>"),
      "faq.html",
    );
    expect(doc.sections).toEqual([{ headings: ["FAQ"], text: "Answer here." }]);
  });

  it("keeps the CSV header with every block of rows", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => `sku-${i},${i}`).join("\n");
    const doc = await parseDocument(text(`sku,price\n${rows}`), "prices.csv");
    expect(doc.sections).toHaveLength(3);
    for (const s of doc.sections) expect(s.text.startsWith("sku,price\n")).toBe(true);
  });

  it("rejects a file whose contents do not match its extension", async () => {
    await expect(parseDocument(text("just text"), "fake.pdf")).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects binary files", () => {
    expect(() => detectFormat(new Uint8Array([0, 1, 2, 0, 3]), "blob.bin")).toThrow(ParseError);
  });

  it("detects a PDF even when misnamed", () => {
    expect(detectFormat(fixture("handbook.pdf"), "notes.txt")).toBe("pdf");
  });

  it("reports empty documents", async () => {
    await expect(parseDocument(text("   \n\n "), "empty.txt")).rejects.toMatchObject({ code: "empty" });
  });

  it("rejects oversized files before parsing", async () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    await expect(parseDocument(big, "big.txt")).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("chunkSections", () => {
  const para = (n: number) => `Sentence number ${n} talks about returns and refunds in some detail.`;
  const long = Array.from({ length: 200 }, (_, i) => para(i)).join(" ");

  it("keeps chunks near the target size with overlap", () => {
    const chunks = chunkSections([{ headings: ["Policy"], text: long }], {
      targetTokens: 200,
      overlapTokens: 30,
    });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(220);
    // Overlap: each chunk starts with text from the end of the previous one.
    const a = chunks[0]!.text;
    const b = chunks[1]!.text.replace(/^Policy\n\n/, "");
    expect(a).toContain(b.slice(0, 40));
  });

  it("never crosses section boundaries and keeps citations", () => {
    const chunks = chunkSections([
      { headings: ["A"], page: 1, text: "Alpha text." },
      { headings: ["B"], page: 2, text: "Beta text." },
    ]);
    expect(chunks.map((c) => [c.headings, c.page])).toEqual([
      [["A"], 1],
      [["B"], 2],
    ]);
    expect(chunks[1]?.text).toBe("B\n\nBeta text.");
  });

  it("hard-wraps text without spaces or punctuation", () => {
    const chunks = chunkSections([{ headings: [], text: "x".repeat(10_000) }], { targetTokens: 100 });
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400);
  });

  it("is deterministic (same input, same hashes)", () => {
    const a = chunkSections([{ headings: [], text: long }]).map((c) => c.contentHash);
    const b = chunkSections([{ headings: [], text: long }]).map((c) => c.contentHash);
    expect(a).toEqual(b);
  });

  it("estimates tokens", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(10);
  });
});
