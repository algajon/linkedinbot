import { prisma } from "../lib/prisma.js";
import { learnToneFromExamples } from "../services/ai.service.js";

// POST /api/tones/learn — distill a tone-of-voice brief from example posts.
// Does not persist; the client reviews/names it, then POSTs to save.
export async function learnTone(req, res) {
  try {
    const { samples } = req.body || {};
    const instruction = await learnToneFromExamples(samples);
    res.json({ instruction });
  } catch (err) {
    const status = /not configured|at least one/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}

// GET /api/tones — list the current user's saved presets.
export async function listTones(req, res, next) {
  try {
    const presets = await prisma.tonePreset.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ presets });
  } catch (err) {
    next(err);
  }
}

// POST /api/tones — save a named tone preset.
export async function createTone(req, res, next) {
  try {
    const name = (req.body.name || "").trim();
    const instruction = (req.body.instruction || "").trim();
    const sampleText = (req.body.sampleText || "").trim() || null;
    if (!name || !instruction) {
      return res.status(400).json({ error: "Name and instruction are required." });
    }
    const preset = await prisma.tonePreset.create({
      data: { userId: req.user.id, name: name.slice(0, 80), instruction: instruction.slice(0, 4000), sampleText },
    });
    res.status(201).json({ preset });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/tones/:id — remove one of the user's presets.
export async function deleteTone(req, res, next) {
  try {
    const result = await prisma.tonePreset.deleteMany({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (result.count !== 1) return res.status(404).json({ error: "Preset not found." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
