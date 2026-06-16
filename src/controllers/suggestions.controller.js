import { prisma } from "../lib/prisma.js";
import { suggestTopics, generatePostsFromSource, parseExemplars } from "../services/ai.service.js";
import { fetchArticle } from "../services/webContext.service.js";
import { getActiveRoutine } from "../services/routine.service.js";
import { normalizePostLanguage } from "../utils/postLanguages.js";

// Resolve a focus topic: explicit input, else the user's latest news watch or
// recent searched topic, so "suggest" works with zero typing once they've used
// the app a little.
async function resolveFocus(userId, explicit) {
  const f = String(explicit || "").trim();
  if (f) return f;
  const watch = await prisma.newsWatch.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
  if (watch?.query) return watch.query;
  const topic = await prisma.recentTopic.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  return topic?.query || "";
}

// POST /api/suggestions — fresh, human post ideas from current news in a field.
export async function suggest(req, res) {
  try {
    const focus = await resolveFocus(req.user.id, req.body?.focus);
    if (!focus) {
      return res.status(400).json({ error: "Enter a focus topic (your industry or interest) to get ideas." });
    }
    const ideas = await suggestTopics({ focus, count: 5 });
    res.json({ focus, ideas });
  } catch (err) {
    const status = /configured|required|No recent|broader/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}

// POST /api/suggestions/draft — one-click: turn a suggested idea into a
// PENDING_APPROVAL draft in the queue, in the chosen archetype + angle.
export async function draftFromSuggestion(req, res) {
  try {
    const account = req.user.linkedinAccount;
    if (!account?.linkedinPersonUrn) {
      return res.status(400).json({ error: "Connect your LinkedIn account before drafting." });
    }
    const { url, title, archetype, angle } = req.body || {};
    if (!url && !title) return res.status(400).json({ error: "Missing the article to draft from." });
    const language = normalizePostLanguage(req.body?.language);

    // Resolve a saved voice preset (instruction + few-shot exemplars) if chosen.
    let tone;
    let exemplars = [];
    let modelOverride;
    if (req.body?.tonePresetId) {
      const preset = await prisma.tonePreset.findFirst({ where: { id: req.body.tonePresetId, userId: req.user.id } });
      if (preset) {
        tone = preset.instruction;
        exemplars = parseExemplars(preset.sampleText);
        modelOverride = preset.openaiModel || undefined;
      }
    }

    let text;
    try {
      const a = await fetchArticle(url);
      text = `${a.title}\n${url}\n\n${a.text}`;
    } catch {
      // Paywalled / unfetchable: ground in the headline + angle so generation still works.
      text = [title, url, angle].filter(Boolean).join("\n");
    }
    if (text.trim().length < 60) text = [title, angle, title].filter(Boolean).join(". ");

    const [body] = await generatePostsFromSource({
      sourceText: text,
      tone,
      exemplars,
      modelOverride,
      archetype,
      stance: angle || undefined,
      count: 1,
      language,
      preferOpenAI: true, // public news -> OpenAI
    });

    const routine = await getActiveRoutine(req.user.id);
    const draft = await prisma.scheduledPost.create({
      data: {
        userId: req.user.id,
        linkedinAccountId: account.id,
        authorUrn: account.linkedinPersonUrn,
        targetType: "PERSONAL_PROFILE",
        body,
        timezone: routine?.timezone || "UTC",
        language,
        status: "PENDING_APPROVAL",
        origin: "AI_GENERATED",
      },
    });
    res.status(201).json({ created: 1, draftId: draft.id });
  } catch (err) {
    const status = /Connect|configured|too little|Missing/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}
