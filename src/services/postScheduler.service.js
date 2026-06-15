import { prisma } from "../lib/prisma.js";
import { getValidAccessToken } from "./token.service.js";
import { publishLinkedInTextPost, uploadImageToLinkedIn } from "./linkedin.service.js";
import { getPostImageFilesWithData } from "./upload.service.js";

const BATCH_SIZE = 25;
// A post stuck in PUBLISHING longer than this is considered abandoned (worker
// crashed mid-publish) and is reclaimed.
const STALE_PUBLISHING_MS = 10 * 60 * 1000;

// Move posts that have been stuck in PUBLISHING for too long back to a terminal
// state. We mark them FAILED (rather than re-SCHEDULING) so we never risk a
// double publish for a post that may have actually gone out — the user can
// inspect and retry manually.
async function reclaimStalePublishing() {
  const cutoff = new Date(Date.now() - STALE_PUBLISHING_MS);
  const result = await prisma.scheduledPost.updateMany({
    where: { status: "PUBLISHING", lockedAt: { lt: cutoff } },
    data: {
      status: "FAILED",
      errorMessage: "Publishing did not complete (worker may have crashed). Please verify on LinkedIn before retrying.",
    },
  });
  return result.count;
}

// Publish a single post that has already been locked into PUBLISHING.
async function publishLockedPost(post) {
  try {
    const account = await prisma.linkedInAccount.findUnique({
      where: { userId: post.userId },
    });
    if (!account) {
      throw new Error("LinkedIn account not connected.");
    }

    const accessToken = await getValidAccessToken(account);

    // Upload any attached images to LinkedIn first, collecting their URNs.
    // Bytes come from the DB (no filesystem dependency). PDFs are skipped here.
    const files = await getPostImageFilesWithData(post.id);
    const mediaUrns = [];
    for (const file of files) {
      if (!file.data) continue; // legacy disk-only rows have no bytes
      const urn = await uploadImageToLinkedIn({
        accessToken,
        authorUrn: post.authorUrn,
        buffer: Buffer.from(file.data),
        mimeType: file.mimeType,
      });
      mediaUrns.push(urn);
    }

    const linkedinPostUrn = await publishLinkedInTextPost({
      accessToken,
      authorUrn: post.authorUrn,
      body: post.body,
      mediaUrns,
    });

    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        status: "PUBLISHED",
        linkedinPostUrn,
        publishedAt: new Date(),
        errorMessage: null,
        lockedAt: null,
      },
    });

    await prisma.publishLog.create({
      data: {
        scheduledPostId: post.id,
        status: "success",
        message: "Post published successfully.",
        response: linkedinPostUrn ? { urn: linkedinPostUrn } : undefined,
      },
    });

    return { id: post.id, status: "PUBLISHED" };
  } catch (error) {
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        status: "FAILED",
        errorMessage: error.message,
        lockedAt: null,
        retryCount: { increment: 1 },
      },
    });

    await prisma.publishLog.create({
      data: {
        scheduledPostId: post.id,
        status: "failed",
        message: error.message,
      },
    });

    return { id: post.id, status: "FAILED", error: error.message };
  }
}

// Core entry point used by both the cron worker script and the internal route.
// Finds due posts, locks each atomically, and publishes them.
export async function runPublishDuePosts() {
  const reclaimed = await reclaimStalePublishing();

  const posts = await prisma.scheduledPost.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
    take: BATCH_SIZE,
    orderBy: { scheduledAt: "asc" },
  });

  const results = [];
  for (const post of posts) {
    // Atomic lock: only one worker can flip SCHEDULED -> PUBLISHING.
    const lock = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "SCHEDULED" },
      data: { status: "PUBLISHING", lockedAt: new Date() },
    });
    if (lock.count !== 1) continue; // someone else grabbed it

    results.push(await publishLockedPost(post));
  }

  return {
    reclaimed,
    attempted: results.length,
    published: results.filter((r) => r.status === "PUBLISHED").length,
    failed: results.filter((r) => r.status === "FAILED").length,
    results,
  };
}

// Retry a single FAILED post by re-arming it. We set it back to SCHEDULED with
// scheduledAt = now so the normal due-post flow (with its locking) picks it up.
export async function retryPost(postId, userId) {
  const result = await prisma.scheduledPost.updateMany({
    where: { id: postId, userId, status: "FAILED" },
    data: { status: "SCHEDULED", scheduledAt: new Date(), errorMessage: null, lockedAt: null },
  });
  return result.count === 1;
}
