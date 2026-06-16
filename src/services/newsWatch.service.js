import { prisma } from "../lib/prisma.js";
import { searchNews, fetchArticle } from "./webContext.service.js";
import { generatePostsFromSource, parseExemplars } from "./ai.service.js";

const MIN_HOURS_BETWEEN_RUNS = 12; // at most ~2 drafts/day per watch
const SEEN_CAP = 80;

export function createWatch(userId, { query, tonePresetId, stance, language }) {
  return prisma.newsWatch.create({
    data: {
      userId,
      query: String(query).trim().slice(0, 200),
      tonePresetId: tonePresetId || null,
      stance: stance || null,
      language: language || "en",
    },
  });
}

export function listWatches(userId) {
  return prisma.newsWatch.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function deleteWatch(id, userId) {
  const r = await prisma.newsWatch.deleteMany({ where: { id, userId } });
  return r.count === 1;
}

// Process a single watch: find the newest unseen article, draft one take into
// the approval queue. Returns true if a draft was created.
async function processWatch(w) {
  const account = await prisma.linkedInAccount.findUnique({ where: { userId: w.userId } });
  if (!account?.linkedinPersonUrn) return false; // needs a connected account to author

  const results = await searchNews(w.query, { count: 8 });
  const seen = new Set(Array.isArray(w.seenUrls) ? w.seenUrls : []);
  const fresh = results.find((r) => r.url && !seen.has(r.url));
  if (!fresh) {
    await prisma.newsWatch.update({ where: { id: w.id }, data: { lastRunAt: new Date() } });
    return false;
  }

  let text;
  try {
    const a = await fetchArticle(fresh.url);
    text = `${a.title}\n${fresh.url}\n\n${a.text}`;
  } catch {
    text = [fresh.title, fresh.description].filter(Boolean).join(". ");
  }

  let tone;
  let exemplars = [];
  if (w.tonePresetId) {
    const p = await prisma.tonePreset.findFirst({ where: { id: w.tonePresetId, userId: w.userId } });
    if (p) {
      tone = p.instruction;
      exemplars = parseExemplars(p.sampleText);
    }
  }

  const [body] = await generatePostsFromSource({
    sourceText: text,
    tone,
    exemplars,
    language: w.language,
    length: "medium",
    count: 1,
    stance: w.stance || "take",
  });
  if (!body) return false;

  await prisma.scheduledPost.create({
    data: {
      userId: w.userId,
      linkedinAccountId: account.id,
      authorUrn: account.linkedinPersonUrn,
      targetType: "PERSONAL_PROFILE",
      body,
      timezone: "UTC",
      language: w.language,
      status: "PENDING_APPROVAL",
      origin: "AI_GENERATED",
    },
  });

  const newSeen = [...seen, fresh.url].slice(-SEEN_CAP);
  await prisma.newsWatch.update({ where: { id: w.id }, data: { seenUrls: newSeen, lastRunAt: new Date() } });
  return true;
}

// Run all active watches that are due. Called from the hourly publish job.
export async function runNewsWatches() {
  const cutoff = new Date(Date.now() - MIN_HOURS_BETWEEN_RUNS * 60 * 60 * 1000);
  const watches = await prisma.newsWatch.findMany({
    where: { active: true, OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }] },
  });
  let drafted = 0;
  for (const w of watches) {
    try {
      if (await processWatch(w)) drafted++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[newswatch]", w.id, err.message);
    }
  }
  return { checked: watches.length, drafted };
}
