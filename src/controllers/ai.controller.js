import { prisma } from "../lib/prisma.js";
import { generatePost, parseExemplars } from "../services/ai.service.js";

// POST /api/ai/generate — generate post body text from a topic + tone.
// When tonePresetId is given, we resolve the saved preset's instruction AND
// inject its real example posts (few-shot) for a far closer voice match.
export async function generate(req, res, next) {
  try {
    const { topic, audience, language, length } = req.body || {};
    let tone = req.body?.tone;
    let exemplars = [];

    if (req.body?.tonePresetId) {
      const preset = await prisma.tonePreset.findFirst({
        where: { id: req.body.tonePresetId, userId: req.user.id },
      });
      if (preset) {
        tone = preset.instruction;
        exemplars = parseExemplars(preset.sampleText);
      }
    }

    const text = await generatePost({ topic, tone, audience, language, length, exemplars });
    res.json({ text });
  } catch (err) {
    const status = /not configured|required/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}
