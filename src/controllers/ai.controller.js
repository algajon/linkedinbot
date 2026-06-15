import { generatePost } from "../services/ai.service.js";

// POST /api/ai/generate — generate post body text from a topic + tone.
export async function generate(req, res, next) {
  try {
    const { topic, tone, audience, language, length } = req.body || {};
    const text = await generatePost({ topic, tone, audience, language, length });
    res.json({ text });
  } catch (err) {
    const status = /not configured|required/i.test(err.message) ? 400 : 502;
    res.status(status).json({ error: err.message });
  }
}
