// File upload handler — stores files temporarily and links them to posts.
// For production, use cloud storage (AWS S3, GCS, etc.). For MVP, store in /uploads/ locally.

import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs/promises";
import { prisma } from "../lib/prisma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads");
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB — full-quality images

// Ensure uploads directory exists
try {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
} catch {
  // dir may already exist
}

// Read a stored upload's raw bytes by filename (used at publish time to push
// the image to LinkedIn).
export async function readUploadedFileBuffer(filename) {
  return fs.readFile(path.join(UPLOADS_DIR, filename));
}

export async function handleFileUpload(file) {
  if (!file) throw new Error("No file provided.");
  if (file.size > MAX_FILE_SIZE) throw new Error("File too large (max 15MB).");

  const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
  if (!allowed.includes(file.mimetype)) {
    throw new Error("Only JPEG, PNG, WebP, and PDF files are allowed.");
  }

  const filename = `${Date.now()}-${file.originalname.replace(/[^a-z0-9.-]/gi, "_")}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  await fs.writeFile(filepath, file.buffer);
  return { filename, mimetype: file.mimetype, size: file.size };
}

// Link an uploaded file to a post
export async function linkFileToPost(postId, userId, file) {
  const post = await prisma.scheduledPost.findFirst({ where: { id: postId, userId } });
  if (!post) throw new Error("Post not found.");

  const uploaded = await handleFileUpload(file);
  const url = `/uploads/${uploaded.filename}`;

  return prisma.uploadedFile.create({
    data: {
      scheduledPostId: postId,
      url,
      filename: uploaded.filename,
      mimeType: uploaded.mimetype,
      size: uploaded.size,
    },
  });
}

// Get all files for a post
export async function getPostFiles(postId, userId) {
  const files = await prisma.uploadedFile.findMany({
    where: {
      scheduledPost: { id: postId, userId },
    },
    orderBy: { createdAt: "desc" },
  });
  return files;
}

// Remove a file from a post
export async function removeFileFromPost(fileId, userId) {
  const file = await prisma.uploadedFile.findFirst({
    where: {
      id: fileId,
      scheduledPost: { userId },
    },
    include: { scheduledPost: true },
  });
  if (!file) throw new Error("File not found.");

  try {
    await fs.unlink(path.join(UPLOADS_DIR, file.filename));
  } catch {
    // file may have already been deleted
  }

  return prisma.uploadedFile.delete({ where: { id: fileId } });
}
