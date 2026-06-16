import { prisma } from "../lib/prisma.js";
import { createFromPdf, createFromUrl, createFromNews, listSources, getSource, deleteSource, decompressText } from "../services/contentSource.service.js";
import { newsSearchEnabled } from "../services/webContext.service.js";
import { generatePostsFromSource, parseExemplars, STANCES } from "../services/ai.service.js";
import { getActiveRoutine } from "../services/routine.service.js";
import { createWatch, listWatches, deleteWatch } from "../services/newsWatch.service.js";
import { recordTopic, listRecentTopics, deleteTopic } from "../services/recentTopic.service.js";
import { normalizePostLanguage } from "../utils/postLanguages.js";

// Page: list sources + upload + generate forms.
export async function renderSources(req, res, next) {
  try {
    const [sources, routine] = await Promise.all([
      listSources(req.user.id),
      getActiveRoutine(req.user.id),
    ]);
    const savedTones = await prisma.tonePreset.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    const watches = await listWatches(req.user.id);
    const recentTopics = await listRecentTopics(req.user.id);
    res.render("sources", {
      title: "Content sources",
      sources,
      savedTones,
      routine,
      watches,
      recentTopics,
      stances: STANCES,
      newsEnabled: newsSearchEnabled(),
      linkedinReady: Boolean(req.user.linkedinAccount?.linkedinPersonUrn),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/sources — upload + parse a PDF.
export async function uploadSource(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided." });
    const source = await createFromPdf(req.user.id, req.file, req.body?.name);
    res.status(201).json({ source: { id: source.id, name: source.name, charCount: source.charCount } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// POST /api/sources/url — add a source from a news/article URL (fetched live).
export async function addUrl(req, res) {
  try {
    const url = (req.body?.url || "").trim();
    if (!url) return res.status(400).json({ error: "A URL is required." });
    const source = await createFromUrl(req.user.id, url);
    res.status(201).json({ source: { id: source.id, name: source.name, charCount: source.charCount, sourceUrls: source.sourceUrls || [] } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// POST /api/sources/news — add a source from a live news search on a topic.
export async function addNews(req, res) {
  try {
    const query = (req.body?.query || "").trim();
    if (!query) return res.status(400).json({ error: "A topic is required." });
    const source = await createFromNews(req.user.id, query);
    const topic = await recordTopic(req.user.id, query);
    res.status(201).json({
      source: { id: source.id, name: source.name, charCount: source.charCount, sourceUrls: source.sourceUrls || [] },
      topic: topic ? { id: topic.id, query: topic.query } : null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// POST /api/sources/watches — create a standing news watch (Tier C).
export async function addWatch(req, res, next) {
  try {
    const query = (req.body?.query || "").trim();
    if (!query) {
      if (req.baseUrl.startsWith("/api")) return res.status(400).json({ error: "A topic is required." });
      return res.redirect("/sources");
    }
    await createWatch(req.user.id, {
      query,
      tonePresetId: req.body?.tonePresetId || null,
      stance: req.body?.stance || null,
      language: normalizePostLanguage(req.body?.language),
    });
    if (req.baseUrl.startsWith("/api")) return res.status(201).json({ ok: true });
    res.redirect("/sources");
  } catch (err) {
    next(err);
  }
}

export async function removeWatch(req, res, next) {
  try {
    await deleteWatch(req.params.id, req.user.id);
    if (req.baseUrl.startsWith("/api")) return res.json({ ok: true });
    res.redirect("/sources");
  } catch (err) {
    next(err);
  }
}

export async function removeTopic(req, res) {
  try {
    await deleteTopic(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function removeSource(req, res, next) {
  try {
    const ok = await deleteSource(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ error: "Source not found." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/sources/:id/generate — create N PENDING_APPROVAL drafts from a source.
export async function generateFromSource(req, res) {
  try {
    const account = req.user.linkedinAccount;
    if (!account?.linkedinPersonUrn) {
      return res.status(400).json({ error: "Connect your LinkedIn account before generating posts." });
    }
    const source = await getSource(req.params.id, req.user.id);
    if (!source) return res.status(404).json({ error: "Source not found." });

    const { audience } = req.body || {};
    const count = Math.max(1, Math.min(7, parseInt(req.body?.count, 10) || 3));
    const language = normalizePostLanguage(req.body?.language);

    // Resolve a saved voice preset (instruction + few-shot exemplars) if chosen.
    let tone = req.body?.tone;
    let exemplars = [];
    let loraModel;
    let modelOverride;
    if (req.body?.tonePresetId) {
      const preset = await prisma.tonePreset.findFirst({
        where: { id: req.body.tonePresetId, userId: req.user.id },
      });
      if (preset) {
        tone = preset.instruction;
        exemplars = parseExemplars(preset.sampleText);
        loraModel = preset.dgxLora || undefined; // per-author LoRA adapter (on-prem)
        modelOverride = preset.openaiModel || undefined; // fine-tuned OpenAI model
      }
    }

    // Public material (news/URL) -> OpenAI; uploaded docs (pdf) -> on-prem cluster.
    const preferOpenAI = source.kind !== "pdf";

    const bodies = await generatePostsFromSource({
      sourceText: decompressText(source.extractedText),
      tone,
      audience,
      count,
      language,
      length: req.body?.length,
      exemplars,
      loraModel,
      modelOverride,
      preferOpenAI,
      stance: req.body?.stance,
    });

    // Default timezone from the user's active routine, else UTC.
    const routine = await getActiveRoutine(req.user.id);
    const timezone = routine?.timezone || "UTC";

    const created = await prisma.$transaction(
      bodies.map((body) =>
        prisma.scheduledPost.create({
          data: {
            userId: req.user.id,
            linkedinAccountId: account.id,
            authorUrn: account.linkedinPersonUrn,
            targetType: "PERSONAL_PROFILE",
            body,
            timezone,
            language,
            status: "PENDING_APPROVAL",
            origin: "AI_GENERATED",
            contentSourceId: source.id,
          },
        })
      )
    );

    res.status(201).json({ created: created.length, drafts: created.map((d) => ({ id: d.id })) });
  } catch (err) {
    // Editorial gate declined the topic — not an error, just a skip with a reason.
    if (err.code === "TOPIC_UNSUITABLE") {
      return res.status(200).json({ created: 0, skipped: true, reason: err.reason });
    }
    const status = /configured|too little|no usable|unparseable/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}
