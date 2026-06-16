import { gzipSync, gunzipSync } from "node:zlib";
import { prisma } from "../lib/prisma.js";
import { extractText } from "./pdf.service.js";
import { fetchArticle, buildNewsContext } from "./webContext.service.js";

const MAX_PDF_SIZE = 15 * 1024 * 1024; // 15 MB
const GZ_PREFIX = "gz1:"; // marks a gzip+base64 encoded value

// Compress extracted text for storage; large source text shrinks ~3-5x.
export function compressText(text) {
  return GZ_PREFIX + gzipSync(Buffer.from(String(text), "utf8")).toString("base64");
}

// Decompress stored text. Plain (legacy, unprefixed) values pass through.
export function decompressText(stored) {
  if (typeof stored !== "string") return "";
  if (!stored.startsWith(GZ_PREFIX)) return stored;
  return gunzipSync(Buffer.from(stored.slice(GZ_PREFIX.length), "base64")).toString("utf8");
}

// Delete sources older than the retention window (SOURCE_RETENTION_DAYS, default
// 30). Set to 0 to disable. Runs periodically from the publish job.
export async function pruneOldSources() {
  const days = parseInt(process.env.SOURCE_RETENTION_DAYS || "30", 10);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.contentSource.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}

// Parse an uploaded PDF and persist its extracted text as a ContentSource.
// We keep only the text — the binary PDF is not stored.
export async function createFromPdf(userId, file, name) {
  if (!file) throw new Error("No file provided.");
  if (file.mimetype !== "application/pdf") {
    throw new Error("Only PDF files are supported as content sources.");
  }
  if (file.size > MAX_PDF_SIZE) {
    throw new Error("PDF too large (max 15MB).");
  }

  const { text, charCount } = await extractText(file.buffer);

  return prisma.contentSource.create({
    data: {
      userId,
      name: (name || file.originalname || "Untitled document").slice(0, 120),
      filename: file.originalname || null,
      kind: "pdf",
      extractedText: compressText(text),
      charCount,
    },
  });
}

// Create a source from a news/article URL (fetched + extracted live).
export async function createFromUrl(userId, url) {
  const { title, text } = await fetchArticle(url);
  return prisma.contentSource.create({
    data: {
      userId,
      name: (title || url).slice(0, 120),
      filename: url,
      kind: "url",
      extractedText: compressText(`${title}\n${url}\n\n${text}`),
      charCount: text.length,
      sourceUrls: [{ title: title || url, url }],
    },
  });
}

// Create a source from a live news search (Brave) on a topic.
export async function createFromNews(userId, query) {
  const { name, text, sources } = await buildNewsContext(query);
  return prisma.contentSource.create({
    data: {
      userId,
      name: name.slice(0, 120),
      filename: null,
      kind: "news",
      extractedText: compressText(text),
      charCount: text.length,
      sourceUrls: sources || [],
    },
  });
}

// "Your sources" lists deliberate, persistent material (uploaded PDFs and added
// URLs). News topic searches are transient and surface as "Recent topics" chips
// instead, so they are excluded here.
export function listSources(userId) {
  return prisma.contentSource.findMany({
    where: { userId, kind: { not: "news" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, filename: true, kind: true, charCount: true, sourceUrls: true, createdAt: true },
  });
}

export function getSource(id, userId) {
  return prisma.contentSource.findFirst({ where: { id, userId } });
}

export async function deleteSource(id, userId) {
  const result = await prisma.contentSource.deleteMany({ where: { id, userId } });
  return result.count === 1;
}
