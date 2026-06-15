// File uploads stored in Postgres (UploadedFile.data) so they survive on
// ephemeral/sleeping hosts (e.g. Render free) and are available at publish time.
// No local filesystem dependency.

import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB — full-quality images
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

function validate(file) {
  if (!file) throw new Error("No file provided.");
  if (file.size > MAX_FILE_SIZE) throw new Error("File too large (max 15MB).");
  if (!ALLOWED.includes(file.mimetype)) {
    throw new Error("Only JPEG, PNG, WebP, and PDF files are allowed.");
  }
}

// Persist an uploaded file's bytes and link it to a post.
export async function linkFileToPost(postId, userId, file) {
  const post = await prisma.scheduledPost.findFirst({ where: { id: postId, userId } });
  if (!post) throw new Error("Post not found.");
  validate(file);

  const id = crypto.randomUUID();
  const filename = file.originalname?.replace(/[^a-z0-9.\-_]/gi, "_") || "upload";
  const created = await prisma.uploadedFile.create({
    data: {
      id,
      scheduledPostId: postId,
      url: `/files/${id}`, // served from the DB, not disk
      filename,
      mimeType: file.mimetype,
      size: file.size,
      data: file.buffer,
    },
  });
  // Never return the bytes to callers.
  return { id: created.id, scheduledPostId: created.scheduledPostId, url: created.url, filename: created.filename, mimeType: created.mimeType, size: created.size, createdAt: created.createdAt };
}

// File metadata for a post (no bytes).
export function getPostFiles(postId, userId) {
  return prisma.uploadedFile.findMany({
    where: { scheduledPost: { id: postId, userId } },
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, filename: true, mimeType: true, size: true, createdAt: true },
  });
}

// One file WITH its bytes, scoped to the owner — for streaming to the browser.
export function getOwnedFileWithData(fileId, userId) {
  return prisma.uploadedFile.findFirst({
    where: { id: fileId, scheduledPost: { userId } },
  });
}

// Image files (with bytes) attached to a post — for publishing to LinkedIn.
export function getPostImageFilesWithData(postId) {
  return prisma.uploadedFile.findMany({
    where: { scheduledPostId: postId, mimeType: { startsWith: "image/" } },
    orderBy: { createdAt: "asc" },
  });
}

export async function removeFileFromPost(fileId, userId) {
  const file = await prisma.uploadedFile.findFirst({
    where: { id: fileId, scheduledPost: { userId } },
  });
  if (!file) throw new Error("File not found.");
  return prisma.uploadedFile.delete({ where: { id: fileId } });
}
