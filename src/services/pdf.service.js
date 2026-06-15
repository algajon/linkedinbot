import { PDFParse } from "pdf-parse";

// Cap extracted text kept per source. Stored compressed, so this is generous;
// generation still only forwards a slice of it (see ai.service).
const MAX_TEXT_CHARS = 100000;

// Extract readable text from a PDF buffer. Returns { text, charCount }.
export async function extractText(buffer) {
  if (!buffer || !buffer.length) {
    throw new Error("Empty PDF file.");
  }
  const parser = new PDFParse({ data: buffer });
  let raw = "";
  try {
    const result = await parser.getText();
    raw = result?.text || "";
  } finally {
    // Release pdf.js resources.
    try {
      await parser.destroy();
    } catch {
      /* ignore */
    }
  }

  // pdf-parse v2 inserts "-- N of M --" page separators; drop them and tidy
  // whitespace so the model sees clean prose.
  const text = raw
    .replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gim, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);

  if (!text) {
    throw new Error("No readable text found in the PDF (it may be scanned images).");
  }
  return { text, charCount: text.length };
}
