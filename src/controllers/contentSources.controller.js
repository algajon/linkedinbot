import { prisma } from "../lib/prisma.js";
import { createFromPdf, listSources, getSource, deleteSource } from "../services/contentSource.service.js";
import { generatePostsFromSource } from "../services/ai.service.js";
import { getActiveRoutine } from "../services/routine.service.js";
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
    res.render("sources", {
      title: "Content sources",
      sources,
      savedTones,
      routine,
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

    const { tone, audience } = req.body || {};
    const count = Math.max(1, Math.min(7, parseInt(req.body?.count, 10) || 3));
    const language = normalizePostLanguage(req.body?.language);

    const bodies = await generatePostsFromSource({
      sourceText: source.extractedText,
      tone,
      audience,
      count,
      language,
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
    const status = /not configured|too little|no usable|unparseable/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}
