import { prisma } from "../lib/prisma.js";

const MAX_RECENT = 12;

// Remember a searched topic (dedup per user; re-searching bumps it to the top).
export async function recordTopic(userId, query) {
  const q = String(query || "").trim().slice(0, 200);
  if (!q) return null;
  return prisma.recentTopic.upsert({
    where: { userId_query: { userId, query: q } },
    create: { userId, query: q },
    update: {}, // updatedAt auto-bumps, moving it to the top of the recent list
  });
}

// Most-recently searched topics, newest first.
export function listRecentTopics(userId, limit = MAX_RECENT) {
  return prisma.recentTopic.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, query: true },
  });
}

export async function deleteTopic(id, userId) {
  const r = await prisma.recentTopic.deleteMany({ where: { id, userId } });
  return r.count === 1;
}
