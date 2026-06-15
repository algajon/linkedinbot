// AI post generation via the OpenAI Chat Completions API.
// Uses fetch directly to avoid adding an SDK dependency.

import { MAX_POST_LENGTH } from "../utils/validation.js";
import { languageName } from "../utils/postLanguages.js";

const COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

// ---- LLM providers -------------------------------------------------------
// vLLM on the on-prem DGX Spark cluster is OpenAI-compatible, so a provider is
// just a base URL + key + model (+ optional headers). Source generation runs
// the user's internal documents through the local cluster when configured, so
// that data never leaves the network. Falls back to OpenAI otherwise.

function openaiProvider() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    headers: {},
    supportsJsonMode: true,
  };
}

// On-prem DGX Spark (vLLM). Only reachable from inside the LAN/VPN.
function dgxProvider() {
  const baseUrl = (process.env.DGX_BASE_URL || "").trim().replace(/\/+$/, "");
  const apiKey = process.env.DGX_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const headers = {};
  const tier = (process.env.DGX_LLM_TIER || "").trim();
  if (tier) headers["X-LLM-Tier"] = tier; // fast | heavy
  return {
    name: "DGX Spark (on-prem)",
    baseUrl,
    apiKey,
    model: process.env.DGX_MODEL || "Qwen/Qwen2.5-72B-Instruct",
    headers,
    // vLLM's response_format support varies by version — rely on prompt + parse.
    supportsJsonMode: false,
    // Qwen3 reasoning models emit chain-of-thought; disable it at the template
    // level (ignored harmlessly by non-reasoning models).
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  };
}

// Provider for source-based generation: prefer the internal cluster so source
// documents stay on-prem; fall back to OpenAI if DGX isn't configured.
function sourceProvider() {
  return dgxProvider() || openaiProvider();
}

// Low-level OpenAI-compatible chat call against any provider.
async function chatCompletion(provider, { messages, temperature = 0.8, maxTokens = 800, jsonMode = false }) {
  const body = { model: provider.model, messages, temperature, max_tokens: maxTokens, ...(provider.extraBody || {}) };
  if (jsonMode && provider.supportsJsonMode) body.response_format = { type: "json_object" };

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      ...provider.headers,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${provider.name} request failed: ${res.status} ${errBody.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(`${provider.name} returned an empty response.`);
  return content;
}


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
  // Built-in preset key, otherwise free text (incl. distilled saved-tone
  // instructions, which can be a few paragraphs).
  return preset ? preset.instruction : String(tone).slice(0, 4000);
}

function buildSystemPrompt(toneInstruction, audience, languageName) {
  return [
    "You are an expert LinkedIn ghostwriter. You write original posts that earn engagement without sounding like generic AI content.",
    `Tone of voice: ${toneInstruction}`,
    languageName ? `Write the entire post in ${languageName}.` : "",
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
export async function generatePost({ topic, tone, audience, language } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  if (!topic || !String(topic).trim()) {
    throw new Error("A topic or prompt is required to generate a post.");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const systemPrompt = buildSystemPrompt(resolveTone(tone), audience, language ? languageName(language) : null);

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

// Generate several distinct LinkedIn post drafts grounded in source material
// (e.g. extracted PDF text), all in the resolved tone. Returns string[].
export async function generatePostsFromSource({ sourceText, tone, count = 3, audience, language } = {}) {
  const provider = sourceProvider();
  if (!provider) {
    throw new Error("No LLM is configured. Set DGX_BASE_URL/DGX_API_KEY (on-prem) or OPENAI_API_KEY.");
  }
  const source = String(sourceText || "").trim();
  if (source.length < 40) {
    throw new Error("The content source has too little text to generate from.");
  }
  const n = Math.max(1, Math.min(7, parseInt(count, 10) || 3));

  const systemPrompt = [
    "You are an expert LinkedIn ghostwriter. Using the SOURCE MATERIAL provided, write original LinkedIn posts.",
    `Tone of voice: ${resolveTone(tone)}`,
    language ? `Write every post in ${languageName(language)}.` : "",
    audience ? `Target audience: ${audience}.` : "",
    `Produce exactly ${n} DISTINCT posts, each covering a different angle, insight, or theme drawn from the source — do not repeat the same point.`,
    "Each post must:",
    "- Be ready to publish: no preamble, no quotation marks, no markdown headings.",
    "- Open with a strong scroll-stopping hook in the first line.",
    "- Use short paragraphs and line breaks for mobile readability.",
    "- Sound human and specific; avoid clichés and buzzword soup.",
    "- Optionally end with 3-5 relevant hashtags on their own line.",
    `- Stay under ${MAX_POST_LENGTH} characters.`,
    `Output the ${n} posts as plain text, separated by a line containing only:`,
    "===POST===",
    "Do not number them and write nothing before the first post or after the last.",
  ]
    .filter(Boolean)
    .join("\n");

  // eslint-disable-next-line no-console
  console.log(`[ai] source generation via ${provider.name} (${provider.model})`);
  const content = await chatCompletion(provider, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `SOURCE MATERIAL:\n\n${source.slice(0, 12000)}` },
    ],
    temperature: 0.85,
    maxTokens: 600 * n,
  });

  // Posts are separated by a delimiter line. This is robust to multi-line post
  // bodies and works across providers (no JSON-escaping pitfalls). Strip any
  // reasoning <think> block first (reasoning models).
  const posts = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .split(/\r?\n?\s*={2,}\s*POST\s*={2,}\s*\r?\n?/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.slice(0, MAX_POST_LENGTH));
  if (!posts.length) {
    throw new Error(`${provider.name} returned no usable posts.`);
  }
  return posts.slice(0, n);
}

// Analyze example posts and distill a reusable tone-of-voice instruction that
// the generator can later use verbatim. Returns a concise style brief.
export async function learnToneFromExamples(samples) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  const text = String(samples || "").trim();
  if (text.length < 80) {
    throw new Error("Paste at least one full example post (a bit more text) to learn a tone.");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const systemPrompt = [
    "You are a writing-style analyst. You are given one or more real LinkedIn posts written by the same person.",
    "Produce a precise, reusable TONE-OF-VOICE BRIEF that another writer could follow to reproduce this exact voice on new topics.",
    "Capture concretely: sentence length and rhythm, hook/opening style, vocabulary and register (formal/casual), use of first vs second person, emoji usage, hashtag habits, line-break/formatting patterns, punctuation quirks, and how posts typically close (CTA, question, etc.).",
    "Write the brief as direct instructions to the writer (imperative voice). Do NOT summarize the topics or quote the posts. Do NOT include a preamble. 120-220 words.",
  ].join("\n");

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
        { role: "user", content: `Here are the example posts:\n\n${text.slice(0, 12000)}` },
      ],
      temperature: 0.4,
      max_tokens: 600,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI request failed: ${res.status} ${errBody.slice(0, 500)}`);
  }

  const data = await res.json();
  const instruction = data.choices?.[0]?.message?.content?.trim();
  if (!instruction) {
    throw new Error("OpenAI returned an empty tone analysis.");
  }
  return instruction.slice(0, 4000);
}
