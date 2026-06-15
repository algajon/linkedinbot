// AI post generation via the OpenAI Chat Completions API.
// Uses fetch directly to avoid adding an SDK dependency.

import { MAX_POST_LENGTH } from "../utils/validation.js";
import { languageName } from "../utils/postLanguages.js";
import { lengthTarget } from "../utils/postLengths.js";

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
  return { content, finishReason: data.choices?.[0]?.finish_reason };
}

// Split a preset's stored sample text into individual exemplar posts.
export function parseExemplars(sampleText) {
  if (!sampleText) return [];
  const parts = /===POST===/.test(sampleText) ? sampleText.split(/===POST===/) : [sampleText];
  return parts.map((s) => s.trim()).filter((s) => s.length > 40);
}

// Build a few-shot block of the author's REAL posts for the system prompt.
// Capped by count and total chars so the prompt stays bounded.
function exemplarBlock(exemplars, { maxPosts = 10, maxChars = 14000 } = {}) {
  if (!Array.isArray(exemplars) || !exemplars.length) return "";
  const chosen = [];
  let total = 0;
  for (const ex of exemplars.slice(0, maxPosts)) {
    if (total + ex.length > maxChars) break;
    chosen.push(ex);
    total += ex.length;
  }
  if (!chosen.length) return "";
  return [
    "STYLE EXAMPLES — these are REAL posts by the author whose voice you must replicate.",
    "Study and match their hooks, sentence length and rhythm, paragraph breaks, vocabulary, level of formality, emoji and punctuation habits, and how they open and close.",
    "Write about the NEW topic only — never reuse their specific content, companies, or anecdotes.",
    "",
    chosen.map((e, i) => `--- Example ${i + 1} ---\n${e}`).join("\n\n"),
  ].join("\n");
}

// Rules that strip the dead giveaways of AI-written posts. Injected into every
// generation prompt; a post-processor (deAiify) enforces the hard ones too.
const ANTI_AI_RULES = [
  "Write like a real person, not an AI. Remove every tell that a post was AI-written:",
  "- NEVER use em dashes or en dashes (— or –). Use a comma, period, or parentheses instead.",
  "- No markdown whatsoever: no **bold**, no headings, and never the '**Label:** explanation' bullet pattern.",
  "- Do NOT use bullet lists OR numbered lists ('-', '*', '•', '1.', '2.'). Write in short standalone lines or flowing sentences, the way the author actually does.",
  "- Emojis only if natural for THIS author, and sparingly. Never decorative rows of emojis.",
  "- Only use hashtags a real person in this field would actually use; no generic filler tags.",
  "- Ban these clichés: game-changer, unlock, unleash, delve, elevate, leverage, robust, seamless, foster, embark, realm, tapestry, testament, ever-evolving, 'in today's fast-paced world', 'the power of', 'when it comes to', 'navigate the landscape', 'dive in', 'in conclusion'.",
  "- Vary sentence length and rhythm; slight imperfection reads as human. Do not sound polished or templated.",
];

// Generic hashtags no real person uses — filtered out of generated tags.
const BANNED_HASHTAGS = new Set(
  [
    "innovation", "success", "growth", "motivation", "mondaymotivation", "motivationmonday",
    "inspiration", "digitaltransformation", "thoughtleadership", "leadership", "gamechanger",
    "synergy", "hustle", "grind", "mindset", "excellence", "teamwork", "businessgrowth",
    "entrepreneurship", "futureofwork", "goals", "winning", "passion", "dreambig",
  ].map((s) => s.toLowerCase())
);

// Post-processor: hard-strip the AI tells the model may still produce.
export function deAiify(text) {
  let t = String(text);
  t = t.replace(/ *[—–] */g, ", "); // spaced em/en dash (classic AI tell) -> comma
  t = t.replace(/—/g, "-"); // any leftover em dash -> hyphen
  t = t.replace(/(\D)\s*–\s*(\D)/g, "$1, $2"); // en dash between words -> comma (leave numeric ranges)
  t = t.replace(/\*\*(.+?)\*\*/g, "$1"); // **bold** -> plain
  t = t.replace(/(^|[\s(])__(.+?)__(?=[\s).,!?]|$)/g, "$1$2"); // __bold__ -> plain
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // markdown headings (not #hashtags)
  t = t.replace(/^\s{0,3}[-*•]\s+/gm, ""); // strip bullet markers -> plain short lines
  t = t.replace(/^\s{0,3}[1-9][.)]\s+/gm, ""); // strip single-digit numbered-list markers
  // Cap egregious emoji spam (backstop; the prompt + examples handle natural use).
  let emoji = 0;
  t = t.replace(/\p{Extended_Pictographic}/gu, (m) => (++emoji <= 6 ? m : ""));
  t = t.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  // Drop any trailing hashtag block the model added — tags are managed/filtered
  // separately and appended after, so we never want the model's own here.
  const isHashtagLine = (l) => /^\s*(?:#[\p{L}\d_]+\s*)+$/u.test(l);
  const lines = t.split("\n");
  while (lines.length && (!lines[lines.length - 1].trim() || isHashtagLine(lines[lines.length - 1]))) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

// When the token cap clips a post mid-sentence, trim back to the last complete
// sentence so it ends cleanly (only applied when the model was actually cut off).
function tidyClippedTail(text) {
  const t = String(text).trim();
  const m = t.match(/^[\s\S]*[.!?…)"'”\]](?=\s|$)/);
  return m && m[0].length > t.length * 0.5 ? m[0].trim() : t;
}

// Separate request that picks fitting hashtags for a post body. Prefers OpenAI
// (the body is public-bound content); falls back to the body's provider. The
// returned tags are appended AFTER generation, so they don't count toward the
// post's length budget. Returns a space-separated string (or "" on failure).
export async function generateHashtags({ text, provider, language, count = 4 } = {}) {
  const tagProvider = openaiProvider() || provider;
  if (!tagProvider || !String(text || "").trim()) return "";
  const sys = [
    "You are a LinkedIn hashtag specialist.",
    `Pick ${count} specific, niche hashtags a real practitioner in this field would actually use for the post below.`,
    "Favor concrete product, industry, event, or topic tags. Mix in a couple the author themselves would use.",
    "BANNED — never output generic filler tags like #Innovation #Success #Growth #Motivation #Inspiration #ThoughtLeadership #DigitalTransformation #GameChanger #Leadership #Mindset #Hustle. They scream 'AI-written'.",
    "Respond with ONLY the hashtags on a single line, space-separated, each in #CamelCase, no duplicates, no other text.",
    language ? `Prefer hashtags suited to ${languageName(language)} where natural; keep standard English tags when widely used.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { content } = await chatCompletion(tagProvider, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: String(text).slice(0, 4000) },
      ],
      temperature: 0.4,
      maxTokens: 60,
    });
    const found = content.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/#[\p{L}\d_]+/gu) || [];
    const seen = new Set();
    const uniq = [];
    for (const tag of found) {
      const k = tag.toLowerCase();
      if (seen.has(k) || BANNED_HASHTAGS.has(k.replace(/^#/, ""))) continue; // drop dupes + generic filler
      seen.add(k);
      uniq.push(tag);
    }
    return uniq.slice(0, count).join(" ");
  } catch {
    return "";
  }
}

// Append a hashtag line to a post body, keeping the whole thing within the cap.
function appendHashtags(body, tags) {
  if (!tags) return body;
  const combined = `${body.trim()}\n\n${tags}`;
  return combined.length <= MAX_POST_LENGTH ? combined : body.trim();
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

function buildSystemPrompt(toneInstruction, audience, languageName, targetChars, exemplars) {
  const block = exemplarBlock(exemplars);
  return [
    "You are an expert LinkedIn ghostwriter. You write original posts that earn engagement without sounding like generic AI content.",
    `Tone of voice: ${toneInstruction}`,
    languageName ? `Write the entire post in ${languageName}.` : "",
    audience ? `Target audience: ${audience}.` : "",
    "Rules:",
    "- Write ONLY the post body — no preamble, no quotation marks, no markdown headings.",
    "- Open with a strong scroll-stopping hook in the first line.",
    "- Use short paragraphs and line breaks for readability on mobile.",
    ...ANTI_AI_RULES,
    "- Do NOT add hashtags; they are generated separately and must not count toward the length budget.",
    targetChars
      ? `- LENGTH BUDGET: about ${targetChars} characters maximum. Be ruthlessly concise — convey the full idea in as few words as possible, and finish your final sentence within the budget. Shorter is better than longer; cut every non-essential word.`
      : "",
    `- Never exceed ${MAX_POST_LENGTH} characters.`,
    block ? `\n${block}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Generate a LinkedIn post. `topic` is what the post should be about.
export async function generatePost({ topic, tone, audience, language, length, exemplars, modelOverride } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  if (!topic || !String(topic).trim()) {
    throw new Error("A topic or prompt is required to generate a post.");
  }

  // A per-author fine-tuned model id (modelOverride) takes precedence.
  const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const systemPrompt = buildSystemPrompt(resolveTone(tone), audience, language ? languageName(language) : null, lengthTarget(length), exemplars);

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
      // Cap tokens to the target length so "short" really is short (~4 chars/token).
      max_tokens: Math.ceil(lengthTarget(length) / 4) + 10,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // Do not surface the API key; only the provider's error message.
    throw new Error(`OpenAI request failed: ${res.status} ${errBody.slice(0, 500)}`);
  }

  const data = await res.json();
  let text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }
  // If the token cap clipped it mid-sentence, trim back to a clean ending.
  if (data.choices?.[0]?.finish_reason === "length") {
    text = tidyClippedTail(text);
  }
  // Strip AI tells, then hard cap on the body.
  text = deAiify(text).slice(0, MAX_POST_LENGTH);
  // Hashtags via a separate request — always added, not counted in the length.
  const tags = await generateHashtags({ text, provider: openaiProvider(), language });
  return appendHashtags(text, tags);
}

// Generate several distinct LinkedIn post drafts grounded in source material
// (e.g. extracted PDF text), all in the resolved tone. Returns string[].
export async function generatePostsFromSource({ sourceText, tone, count = 3, audience, language, length, exemplars, loraModel } = {}) {
  let provider = sourceProvider();
  if (!provider) {
    throw new Error("No LLM is configured. Set DGX_BASE_URL/DGX_API_KEY (on-prem) or OPENAI_API_KEY.");
  }
  // Route to a per-author LoRA adapter served by vLLM, if one is set.
  if (loraModel && provider.name?.startsWith("DGX")) {
    provider = { ...provider, model: loraModel };
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
    ...ANTI_AI_RULES,
    "- Do NOT add hashtags; they are generated separately and must not count toward the length budget.",
    `- LENGTH BUDGET: about ${lengthTarget(length)} characters each — be ruthlessly concise, say the same thing with fewer words, and finish each post's final sentence within the budget.`,
    `- Never exceed ${MAX_POST_LENGTH} characters.`,
    `Output the ${n} posts as plain text, separated by a line containing only:`,
    "===POST===",
    "Do not number them and write nothing before the first post or after the last.",
    exemplarBlock(exemplars) ? `\n${exemplarBlock(exemplars)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // eslint-disable-next-line no-console
  console.log(`[ai] source generation via ${provider.name} (${provider.model})`);
  const { content, finishReason } = await chatCompletion(provider, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `SOURCE MATERIAL:\n\n${source.slice(0, 40000)}` },
    ],
    temperature: 0.85,
    // Per-post token budget scaled to the target length, times the post count.
    maxTokens: (Math.ceil(lengthTarget(length) / 4) + 14) * n,
  });

  // Posts are separated by a delimiter line. This is robust to multi-line post
  // bodies and works across providers (no JSON-escaping pitfalls). Strip any
  // reasoning <think> block first (reasoning models).
  const posts = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .split(/\r?\n?\s*={2,}\s*POST\s*={2,}\s*\r?\n?/i)
    // Strip any trailing partial delimiter the token cap may have clipped (e.g. "===").
    .map((p) => p.replace(/\s*={2,}[\s\S]*$/, "").trim())
    .filter(Boolean)
    .map((p) => p.slice(0, MAX_POST_LENGTH));
  if (!posts.length) {
    throw new Error(`${provider.name} returned no usable posts.`);
  }
  // If the cap clipped output, only the last post can be cut off — tidy its tail.
  if (finishReason === "length" && posts.length) {
    posts[posts.length - 1] = tidyClippedTail(posts[posts.length - 1]);
  }
  // Strip AI tells, then add fitting hashtags (not length-counted).
  const withTags = [];
  for (const raw of posts.slice(0, n)) {
    const body = deAiify(raw).slice(0, MAX_POST_LENGTH);
    const tags = await generateHashtags({ text: body, provider, language });
    withTags.push(appendHashtags(body, tags));
  }
  return withTags;
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
