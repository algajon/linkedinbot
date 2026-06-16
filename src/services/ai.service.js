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

// Keep a post on a single subject (no bait-and-switch). Applied to every post.
const COHERENCE_RULES = [
  "- Stay on ONE subject from the first line to the last. Never pivot from the topic into a generic business lesson, a productivity/safety tip, self-promotion, or an unrelated call-to-action.",
  "- If you end with a question, it must be about the SAME subject as the post, not a bolted-on engagement prompt.",
];

// For tragedies / sensitive events: be human, never self-serving.
const SENSITIVITY_RULES = [
  "- This concerns a sensitive event (loss of life, tragedy, disaster, violence, or similar). Be sincere and human.",
  "- Do NOT turn it into a business lesson, a tip for 'your projects', marketing, or self-promotion.",
  "- Do NOT add an engagement-bait question or call-to-action. A short, respectful reflection is enough.",
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

// Editorial stance for commentary on a source (e.g. news). Free text passes through.
export const STANCES = {
  take: { label: "Sharp take", instruction: "Share a clear, opinionated point of view. Take a side and own it." },
  supportive: { label: "Supportive", instruction: "Argue in favor: why this matters and is a positive development." },
  contrarian: { label: "Contrarian", instruction: "Challenge the prevailing narrative with a well-reasoned contrarian angle." },
  implications: { label: "What it means", instruction: "Focus on the practical implications for the audience and their industry." },
  mythbust: { label: "Myth-bust", instruction: "Correct a common misconception this surfaces." },
  predict: { label: "Prediction", instruction: "Make a concrete prediction about what happens next, grounded in the facts." },
};

export function resolveStance(stance) {
  if (!stance) return "";
  return STANCES[stance]?.instruction || String(stance).slice(0, 300);
}

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
    ...COHERENCE_RULES,
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

// Quality engine: rubric-driven best-of-N + self-refine. On by default; set
// CONTENT_QUALITY=off to fall back to single-shot (faster/cheaper).
const QUALITY = (process.env.CONTENT_QUALITY || "on").trim().toLowerCase() !== "off";

const QUALITY_RUBRIC = [
  "Judge a LinkedIn post on each dimension (1-10):",
  "1. HOOK - the first line stops the scroll (curiosity, tension, a number, or a contrarian take).",
  "2. ONE IDEA - a single clear point, not several half-ideas.",
  "3. SPECIFIC - a concrete detail, example, or number; no vague filler.",
  "4. VALUE - the reader learns or feels something worthwhile.",
  "5. READABLE - short lines, white space, a clean arc (hook -> insight -> payoff).",
  "6. AUTHENTIC - sounds like a real person; zero AI tells (no em dashes, markdown, bullet/numbered lists, cliches).",
  "7. ENGAGEMENT - ends on a natural question or invitation, never forced.",
].join("\n");

// One draft from a provider, with clip-repair + AI-tell scrubbing applied.
async function draftPost(provider, { system, user, targetChars, temperature = 0.85 }) {
  const { content, finishReason } = await chatCompletion(provider, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    maxTokens: Math.ceil(targetChars / 4) + 24,
  });
  let text = content;
  if (finishReason === "length") text = tidyClippedTail(text);
  return deAiify(text).slice(0, MAX_POST_LENGTH);
}

// LLM-as-judge: pick the strongest draft (hook + authenticity weighted).
async function judgeBest(provider, drafts) {
  if (drafts.length <= 1) return drafts[0] || "";
  const sys = [
    "You are a ruthless LinkedIn editor.",
    QUALITY_RUBRIC,
    "Weight HOOK and AUTHENTIC most heavily. A boring or AI-sounding opener disqualifies a post.",
    'Return ONLY JSON: {"best": <0-based index of the single strongest post>}.',
  ].join("\n");
  const list = drafts.map((d, i) => `### Post ${i}\n${d}`).join("\n\n");
  try {
    const { content } = await chatCompletion(provider, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: list },
      ],
      temperature: 0.2,
      maxTokens: 30,
    });
    const m = content.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/\d+/);
    const idx = m ? parseInt(m[0], 10) : 0;
    return drafts[idx] || drafts[0];
  } catch {
    return drafts[0];
  }
}

// Critique-and-rewrite pass: lift a draft against the rubric, keeping the voice.
async function refineDraft(provider, { draft, voiceSystem, targetChars, grounded = false } = {}) {
  const sys = [
    voiceSystem,
    "Now REVISE the draft below so it scores high on every point of this rubric, while keeping the author's voice and topic:",
    QUALITY_RUBRIC,
    `Tighten to about ${targetChars} characters. Strengthen the first-line hook, cut every filler word, keep a clean human arc and a natural closing line.`,
    grounded
      ? "Do NOT introduce any fact, name, number, or claim that is not already in the draft."
      : "Add one concrete specific if it makes the post land harder.",
    "Output ONLY the improved post — no preamble, no hashtags, no markdown, no em dashes, no bullet or numbered lists.",
  ].join("\n");
  try {
    const out = await draftPost(provider, { system: sys, user: draft, targetChars, temperature: 0.6 });
    return out && out.length > 40 ? out : draft;
  } catch {
    return draft;
  }
}

// Thrown when the editorial gate decides this author shouldn't post a topic.
export class TopicUnsuitableError extends Error {
  constructor(reason) {
    super(reason || "This topic isn't a natural fit for this author.");
    this.code = "TOPIC_UNSUITABLE";
    this.reason = reason || "Not a natural fit for this author.";
  }
}

// Editorial gate: given source material and the author's voice/domain, decide
// whether THIS author should post about it, whether it's sensitive, and the
// appropriate angle. Conservative by design (declines newsjacking/off-topic).
export async function assessTopic(provider, { sourceText, voiceInstruction, exemplars } = {}) {
  if (!provider) return { shouldPost: true, sensitive: false, angle: "", reason: "" };
  const domain = (exemplars || [])
    .slice(0, 4)
    .map((e) => e.split("\n")[0].slice(0, 80))
    .join(" | ");
  const sys = [
    "You are the editorial gatekeeper for ONE specific LinkedIn author.",
    voiceInstruction ? `Author voice/brief: ${String(voiceInstruction).slice(0, 800)}` : "",
    domain ? `The author normally posts about: ${domain}` : "",
    "Decide whether this author should post about the material below, and how.",
    'Return ONLY JSON: {"shouldPost": boolean, "sensitive": boolean, "angle": "<one sentence>", "reason": "<brief>"}.',
    "shouldPost=false if the subject is outside the author's field, or a tragedy/disaster/loss/politics they have no genuine standing to comment on, or anything that would read as newsjacking. When unsure about relevance or taste, choose false.",
    "sensitive=true for loss of life, tragedy, disaster, violence, layoffs, politics, or similar; then the angle must be respectful with no business lesson, no self-promotion, and no engagement-bait question.",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { content } = await chatCompletion(provider, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: String(sourceText).slice(0, 6000) },
      ],
      temperature: 0.1,
      maxTokens: 200,
    });
    const m = content.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return {
      shouldPost: j.shouldPost !== false,
      sensitive: Boolean(j.sensitive),
      angle: typeof j.angle === "string" ? j.angle : "",
      reason: typeof j.reason === "string" ? j.reason : "",
    };
  } catch {
    return { shouldPost: true, sensitive: false, angle: "", reason: "" }; // fail open on parser/transient errors
  }
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
  const base = openaiProvider();
  const provider = modelOverride ? { ...base, model: modelOverride } : base;
  const target = lengthTarget(length);
  const voiceSystem = buildSystemPrompt(resolveTone(tone), audience, language ? languageName(language) : null, target, exemplars);
  const user = `Write a LinkedIn post about: ${String(topic).trim()}`;

  // Best-of-N: varied temperatures give different hooks/angles to choose from.
  const temps = QUALITY ? [0.9, 0.75, 1.05] : [0.85];
  const drafts = (
    await Promise.all(
      temps.map((t) => draftPost(provider, { system: voiceSystem, user, targetChars: target, temperature: t }).catch(() => null))
    )
  ).filter((d) => d && d.length > 40);
  if (!drafts.length) throw new Error("OpenAI returned an empty response.");

  // Judge-pick the strongest, then a self-refine pass to lift it further.
  let best = QUALITY ? await judgeBest(provider, drafts) : drafts[0];
  if (QUALITY) best = await refineDraft(provider, { draft: best, voiceSystem, targetChars: target });
  best = best.slice(0, MAX_POST_LENGTH);

  // Hashtags via a separate request — always added, not counted in the length.
  const tags = await generateHashtags({ text: best, provider: openaiProvider(), language });
  return appendHashtags(best, tags);
}

// Generate several distinct LinkedIn post drafts grounded in source material
// (e.g. extracted PDF text), all in the resolved tone. Returns string[].
export async function generatePostsFromSource({ sourceText, tone, count = 3, audience, language, length, exemplars, loraModel, stance } = {}) {
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

  // Editorial gate: should this author post this at all, and how?
  const assessment = await assessTopic(provider, { sourceText: source, voiceInstruction: resolveTone(tone), exemplars });
  if (!assessment.shouldPost) throw new TopicUnsuitableError(assessment.reason);
  const sensitive = assessment.sensitive;
  const effStance = sensitive ? "" : stance; // never apply a provocative stance to a tragedy

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
    "- Ground every claim, number, name, and fact strictly in the SOURCE MATERIAL. Never invent statistics, quotes, or details that are not in the source.",
    "- Carry one clear idea and end with a takeaway or a natural question.",
    !sensitive && resolveStance(effStance)
      ? `- ANGLE: ${resolveStance(effStance)} This is the author's commentary/opinion on the material, not a neutral summary — but every fact must still come from the source.`
      : "",
    !sensitive && !resolveStance(effStance) && assessment.angle
      ? `- ANGLE: ${assessment.angle}`
      : "",
    ...ANTI_AI_RULES,
    ...COHERENCE_RULES,
    ...(sensitive ? SENSITIVITY_RULES : []),
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
  // Strip AI tells, self-refine against the rubric (grounded in the draft), then
  // add fitting hashtags (not length-counted).
  const voiceSystem = buildSystemPrompt(resolveTone(tone), audience, language ? languageName(language) : null, lengthTarget(length), exemplars);
  const withTags = [];
  for (const raw of posts.slice(0, n)) {
    let body = deAiify(raw).slice(0, MAX_POST_LENGTH);
    if (QUALITY) {
      body = await refineDraft(provider, { draft: body, voiceSystem, targetChars: lengthTarget(length), grounded: true });
    }
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
