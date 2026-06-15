import { prisma } from "../lib/prisma.js";
import { extractText } from "./pdf.service.js";

const MAX_PDF_SIZE = 15 * 1024 * 1024; // 15 MB

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
      extractedText: text,
      charCount,
    },
  });
}

export function listSources(userId) {
  return prisma.contentSource.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, filename: true, charCount: true, createdAt: true },
  });
}

export function getSource(id, userId) {
  return prisma.contentSource.findFirst({ where: { id, userId } });
}

export async function deleteSource(id, userId) {
  const result = await prisma.contentSource.deleteMany({ where: { id, userId } });
  return result.count === 1;
}
