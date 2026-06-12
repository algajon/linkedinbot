// AI post generation via the OpenAI Chat Completions API.
// Uses fetch directly to avoid adding an SDK dependency.

import { MAX_POST_LENGTH } from "../utils/validation.js";

const COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

// Preset tones map a short key to a richer instruction the model can act on.
// A free-text tone (anything not in this map) is passed through verbatim.
export const TONE_PRESETS = {
  professional: {
    label: "Professional & authoritative",
    instruction:
      "Confident, credible, and polished. Lead with insight, back claims with substance, and avoid fluff or hype.",
  },
  conversational: {
    label: "Conversational & friendly",
    instruction:
      "Warm, approachable, and human. Write like you're talking to a smart colleague. Short sentences, plain language.",
  },
  bold: {
    label: "Bold & contrarian",
    instruction:
      "Punchy and opinionated. Open with a strong, slightly provocative hook that challenges conventional wisdom, then back it up.",
  },
  inspirational: {
    label: "Inspirational & motivational",
    instruction:
      "Uplifting and energizing. Tell it through a personal lens, build to a memorable takeaway, and end on momentum.",
  },
  storytelling: {
    label: "Storytelling",
    instruction:
      "Narrative-driven. Open mid-scene with a concrete moment, build tension, and land a clear lesson at the end.",
  },
};

export function resolveTone(tone) {
  if (!tone) return TONE_PRESETS.professional.instruction;
  const preset = TONE_PRESETS[tone];
  return preset ? preset.instruction : String(tone).slice(0, 500);
}

function buildSystemPrompt(toneInstruction, audience) {
  return [
    "You are an expert LinkedIn ghostwriter. You write original posts that earn engagement without sounding like generic AI content.",
    `Tone of voice: ${toneInstruction}`,
    audience ? `Target audience: ${audience}.` : "",
    "Rules:",
    "- Write ONLY the post body — no preamble, no quotation marks, no markdown headings.",
    "- Open with a strong scroll-stopping hook in the first line.",
    "- Use short paragraphs and line breaks for readability on mobile.",
    "- Sound human and specific; avoid clichés, buzzword soup, and em-dash overuse.",
    "- Optionally end with 3-5 relevant hashtags on their own line.",
    `- Keep the entire post under ${MAX_POST_LENGTH} characters.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Generate a LinkedIn post. `topic` is what the post should be about.
export async function generatePost({ topic, tone, audience } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  if (!topic || !String(topic).trim()) {
    throw new Error("A topic or prompt is required to generate a post.");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const systemPrompt = buildSystemPrompt(resolveTone(tone), audience);

  const res = await fetch(COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Write a LinkedIn post about: ${String(topic).trim()}` },
      ],
      temperature: 0.8,
      max_tokens: 800,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // Do not surface the API key; only the provider's error message.
    throw new Error(`OpenAI request failed: ${res.status} ${errBody.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }
  // Hard cap so generated content can never exceed LinkedIn's limit.
  return text.slice(0, MAX_POST_LENGTH);
}
