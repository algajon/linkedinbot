// AI post generation via the OpenAI Chat Completions API.
// Uses fetch directly to avoid adding an SDK dependency.

import { MAX_POST_LENGTH } from "../utils/validation.js";
import { languageName } from "../utils/postLanguages.js";
import { lengthTarget } from "../utils/postLengths.js";
import { searchNews } from "./webContext.service.js";

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
    model: process.env.OPENAI_MODEL || "gpt-4o",
    headers: {},
    supportsJsonMode: true,
  };
}

// Anthropic Claude via the Messages API. Different wire shape from OpenAI:
// system is a top-level param, the endpoint is /v1/messages, auth is x-api-key,
// and Opus/Sonnet 4.x reject `temperature` — so chatCompletion has a dedicated
// branch for kind === "anthropic" that drops it and reshapes the request.
function anthropicProvider() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return {
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey,
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    headers: {},
    supportsJsonMode: false, // no response_format; rely on prompt + parse
  };
}

// Provider for public-bound content generation (posts, hashtags, ideas, tone
// briefs). Prefer Anthropic Claude when configured, else OpenAI.
function publicProvider() {
  return anthropicProvider() || openaiProvider();
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
  return dgxProvider() || publicProvider();
}

// Anthropic Messages API call. Lifts the system message to the top-level param,
// keeps the user/assistant turns, and never sends temperature (rejected by
// Opus/Sonnet 4.x). A floor on max_tokens keeps the OpenAI-tuned tiny budgets
// from truncating Claude mid-output, and a final-answer instruction stops Opus
// from leaking reasoning into the response when thinking is off. Maps the
// result back to the {content, finishReason} shape the callers expect.
async function anthropicCompletion(provider, { messages, maxTokens }) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) }));
  const sys = [system, "Respond with only the requested output: no preamble, and no explanation of your process."]
    .filter(Boolean)
    .join("\n");
  const body = {
    model: provider.model,
    max_tokens: Math.max(maxTokens, 512),
    system: sys,
    messages: turns.length ? turns : [{ role: "user", content: "." }],
  };
  const res = await fetch(`${provider.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${provider.name} request failed: ${res.status} ${errBody.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!content) throw new Error(`${provider.name} returned an empty response.`);
  return { content, finishReason: data.stop_reason === "max_tokens" ? "length" : "stop" };
}

// Low-level chat call against any provider. OpenAI-compatible by default; routes
// to the Anthropic Messages API for kind === "anthropic".
async function chatCompletion(provider, { messages, temperature = 0.8, maxTokens = 800, jsonMode = false }) {
  if (provider.kind === "anthropic") return anthropicCompletion(provider, { messages, maxTokens });
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

// Allowlist of real, established LinkedIn hashtags (active communities). Generated
// tags must come from this set, so we never fabricate one from a headline (e.g.
// #B52Bomber, #EdwardsAFB). It's a curated, refreshable list — not "live
// trending" (LinkedIn has no open API for that), but every tag here is real and
// actually used. Matched case-insensitively. Keep specific enough to not read as
// filler, broad enough to cover common professional topics.
const REAL_HASHTAGS = [
  // Tech & AI
  "ArtificialIntelligence", "MachineLearning", "GenerativeAI", "DataScience", "BigData",
  "CloudComputing", "Cybersecurity", "SoftwareEngineering", "DevOps", "WebDevelopment",
  "SaaS", "Programming", "OpenSource", "TechNews", "Automation", "InternetOfThings",
  // Retail / signage / hospitality (the user's space)
  "RetailTech", "Retail", "DigitalSignage", "CustomerExperience", "Ecommerce",
  "Hospitality", "FoodAndBeverage", "RetailDesign", "Omnichannel", "EInk",
  // Business & strategy
  "Entrepreneur", "Startups", "SmallBusiness", "VentureCapital", "BusinessStrategy",
  "ProductManagement", "ProjectManagement", "Consulting", "B2B", "B2BMarketing",
  // Marketing & sales
  "DigitalMarketing", "ContentMarketing", "SocialMediaMarketing", "SEO", "Branding",
  "MarketingStrategy", "Sales", "CustomerSuccess", "PublicRelations",
  // Design & product
  "UXDesign", "UIDesign", "ProductDesign", "DesignThinking",
  // People & ops
  "HumanResources", "TalentAcquisition", "Recruiting", "RemoteWork", "Productivity",
  "SupplyChain", "Logistics", "Manufacturing",
  // Finance & industry
  "Fintech", "Finance", "Investing", "RealEstate", "Healthcare", "HealthTech",
  "EdTech", "Sustainability", "CleanEnergy", "ClimateTech", "ESG", "RenewableEnergy",
];
const REAL_HASHTAG_LOOKUP = new Map(REAL_HASHTAGS.map((t) => [t.toLowerCase(), t]));

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
  // Straighten the typographic marks AI reaches for but people rarely type by hand.
  t = t.replace(/[‘’‚‛]/g, "'"); // curly single quotes / apostrophes
  t = t.replace(/[“”„‟]/g, '"'); // curly double quotes
  t = t.replace(/…/g, "..."); // ellipsis character
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
export async function generateHashtags({ text, provider, language, count = 3, sensitive = false } = {}) {
  const tagProvider = provider || publicProvider();
  if (sensitive) return ""; // never tag a tragedy / somber post
  if (!tagProvider || !String(text || "").trim()) return "";
  const sys = [
    "You attach hashtags to a LinkedIn post, but ONLY when they genuinely fit. Reason about THIS post's topic first.",
    "Return NONE (empty list) for posts about a death, tragedy, accident, crash, disaster, violence, illness, layoffs, or any somber or serious news event. Hashtags there read as engagement farming and are disrespectful.",
    "You may ONLY use hashtags from the ALLOWED list below. Never invent a hashtag, and NEVER build one from a name, place, company, product, event, model number, or acronym in the post (for example never #B52Bomber or #EdwardsAFB). Those are fabricated, not real.",
    `ALLOWED HASHTAGS: ${REAL_HASHTAGS.map((t) => "#" + t).join(" ")}`,
    `Choose at most ${count} that a real practitioner would actually attach to this post. Fewer is better. If fewer than two genuinely fit, return none.`,
    'Respond with ONLY JSON: {"appropriate": <true|false>, "hashtags": ["#Tag", ...]}.',
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { content } = await chatCompletion(tagProvider, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: String(text).slice(0, 4000) },
      ],
      temperature: 0.2,
      maxTokens: 100,
      jsonMode: true,
    });
    const clean = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
    let parsed = {};
    try { parsed = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch { /* fall back to scan */ }
    if (parsed.appropriate === false) return ""; // model judged hashtags inappropriate here
    const candidates = Array.isArray(parsed.hashtags) ? parsed.hashtags : (clean.match(/#[\p{L}\d_]+/gu) || []);
    const seen = new Set();
    const out = [];
    for (const raw of candidates) {
      const core = String(raw).replace(/^#/, "").toLowerCase();
      const real = REAL_HASHTAG_LOOKUP.get(core); // allowlist => guaranteed real, never fabricated
      if (!real || seen.has(core)) continue;
      seen.add(core);
      out.push("#" + real);
    }
    return out.slice(0, count).join(" ");
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

// Post archetypes: the FORMAT/shape of a post. These are the structures that
// reliably earn engagement on LinkedIn, weighted toward warm, human, lifestyle
// framings (the opposite of corporate filler). Selectable as a reusable preset
// for routine posting. Free text passes through.
export const POST_ARCHETYPES = {
  story: {
    label: "Personal story → lesson",
    instruction:
      "Open in the middle of one specific personal moment (a scene, a line someone said, a small detail). Tell it like a human remembering it, then let a single honest takeaway surface near the end. Warmth over polish.",
  },
  behind_scenes: {
    label: "Behind the scenes",
    instruction:
      "Show the unglamorous reality behind the work, a day-in-the-life or how it actually gets done. Concrete and specific, a little messy, no corporate gloss.",
  },
  reflection: {
    label: "Honest reflection",
    instruction:
      "Share a genuine reflection: something you changed your mind about, or a mistake and what it taught you. Vulnerable and real, never a humblebrag.",
  },
  gratitude: {
    label: "People & gratitude",
    instruction:
      "Spotlight a person, team, or small act that mattered. Be specific and sincere, and make the other person the hero of the post, not yourself.",
  },
  relatable: {
    label: "Relatable observation",
    instruction:
      "Name one small, true observation about work or everyday life that makes people quietly nod. Light, human, a touch of dry humor.",
  },
  contrarian: {
    label: "Gentle contrarian take",
    instruction:
      "Question a common belief in the field, kindly and with reasons. Open a conversation rather than dunk on anyone.",
  },
  howto: {
    label: "Actionable how-to",
    instruction:
      "Give a few concrete, usable steps drawn from real experience. Practical and generous, written like a person helping a friend, not a textbook.",
  },
};

export function resolveArchetype(archetype) {
  if (!archetype) return "";
  return POST_ARCHETYPES[archetype]?.instruction || String(archetype).slice(0, 300);
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

// The single biggest "this is AI" giveaway is the polished LinkedIn template:
// punchy hook, one-line-per-thought cadence, a tidy lesson, an inspirational
// closer. This pass deliberately roughs that up into something a real person
// would type, in THIS author's voice. It runs LAST so it has the final word.
const HUMANIZE_RULES = [
  "Make it read like a real person typed it in one sitting, not like polished marketing or AI copy.",
  "- Cut throat-clearing and meta openers: no 'Here's the thing', 'Let's be honest', 'In a world where', 'Imagine...', 'We've all been there', 'Picture this'.",
  "- Break the formulaic LinkedIn shape: do NOT use the hook / short-line / tidy-lesson / inspirational-closer template, and do NOT put every sentence on its own line all the way down.",
  "- No grand sign-offs or thesis-restating closers: drop 'The future is...', 'One thing is clear', 'At the end of the day', 'The bottom line', 'Remember:'.",
  "- Kill the contrast gimmick 'It's not just X, it's Y' and rule-of-three lists used only for rhythm.",
  "- Prefer one concrete detail (a name, a number, a specific moment) over any abstract claim. If a sentence could sit on anyone's post, cut or sharpen it.",
  "- Vary the rhythm: short blunt sentences next to a longer one. A little unevenness reads as human.",
  "- Contractions are fine. Starting with And/But/So is fine. State an opinion flatly without hedging. Don't add a moral or over-explain, trust the reader.",
];

// Final pass: rewrite a polished draft to sound unmistakably human, re-anchored
// on the author's real voice/examples. Keeps topic, facts, and meaning.
async function humanizeDraft(provider, { draft, voiceSystem, targetChars } = {}) {
  const sys = [
    voiceSystem, // re-asserts the author's voice + few-shot exemplars + anti-AI rules
    "Rewrite the post below so it sounds like THIS author actually wrote it. Keep the same topic, facts, and meaning, but remove every trace of AI phrasing and structure.",
    ...HUMANIZE_RULES,
    `Keep it around ${targetChars} characters. Output ONLY the rewritten post, nothing else.`,
  ].join("\n");
  try {
    const out = await draftPost(provider, { system: sys, user: draft, targetChars, temperature: 0.85 });
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
export async function assessTopic(provider, { sourceText, voiceInstruction, exemplars, strict = false } = {}) {
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
    // RELEVANCE drives shouldPost — NOT sensitivity.
    "shouldPost is about RELEVANCE and standing, not sensitivity. Set shouldPost=true when the subject is in or adjacent to the author's field/expertise/interests, or a moment they could authentically and appropriately acknowledge.",
    "Set shouldPost=false ONLY when the subject is clearly outside the author's world or commenting would look like opportunistic newsjacking of an unrelated event.",
    "Do NOT set shouldPost=false merely because the topic is sad or sensitive — a sensitive topic the author can genuinely speak to SHOULD still be posted, just respectfully.",
    "sensitive=true for loss of life, tragedy, disaster, violence, layoffs, or politics. When sensitive, the angle must be respectful: no business lesson, no self-promotion, no engagement-bait question.",
    strict
      ? "This is for an automated feed: if relevance is genuinely doubtful, prefer shouldPost=false."
      : "The author explicitly chose this material, so lean toward shouldPost=true; only decline when the mismatch is clear.",
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
export async function generatePost({ topic, tone, audience, language, length, exemplars, modelOverride, archetype } = {}) {
  const base = publicProvider();
  if (!base) {
    throw new Error("No public LLM is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  }
  if (!topic || !String(topic).trim()) {
    throw new Error("A topic or prompt is required to generate a post.");
  }

  // A per-author fine-tuned model id (modelOverride) applies only to OpenAI.
  const provider = modelOverride && base.name === "OpenAI" ? { ...base, model: modelOverride } : base;
  const target = lengthTarget(length);
  let voiceSystem = buildSystemPrompt(resolveTone(tone), audience, language ? languageName(language) : null, target, exemplars);
  const arch = resolveArchetype(archetype);
  if (arch) voiceSystem += `\nFORMAT (post archetype): ${arch}`;
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
  if (QUALITY) {
    best = await refineDraft(provider, { draft: best, voiceSystem, targetChars: target });
    best = await humanizeDraft(provider, { draft: best, voiceSystem, targetChars: target });
  }
  best = best.slice(0, MAX_POST_LENGTH);

  // Hashtags via a separate request — always added, not counted in the length.
  const tags = await generateHashtags({ text: best, provider, language });
  return appendHashtags(best, tags);
}

// Daily idea engine: turn fresh news in the user's field into warm, human post
// ideas. Each idea = a real article + a best-fit archetype + a one-line human
// angle. The user one-click drafts any idea. Returns [] when nothing fits.
export async function suggestTopics({ focus, count = 5 } = {}) {
  const provider = publicProvider();
  if (!provider) throw new Error("No public LLM is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  const f = String(focus || "").trim();
  if (!f) throw new Error("A focus topic is required to suggest ideas.");

  const results = (await searchNews(f, { count: Math.max(count + 5, 10) })).filter((r) => r.url && r.title);
  if (!results.length) throw new Error(`No recent news found for "${f}". Try a broader topic.`);
  const items = results.slice(0, 10);

  const archetypeList = Object.entries(POST_ARCHETYPES).map(([k, v]) => `${k} (${v.label})`).join(", ");
  const sys = [
    "You help a LinkedIn creator turn fresh news headlines into warm, human, lifestyle-flavored post ideas, never corporate or hypey.",
    `For each promising headline, propose ONE idea: pick the best-fit archetype from [${archetypeList}] and write a single human ANGLE sentence the author could take, grounded in that headline.`,
    "Strongly favor personal, reflective, relatable, behind-the-scenes, and gratitude framings. Skip pure tragedy or anything that can't be made genuinely human.",
    `Choose the best ${count} headlines. Return ONLY JSON: {"ideas":[{"index":<headline number>,"archetype":"<key>","angle":"<one sentence>"}]}.`,
  ].join("\n");
  const user = items.map((r, i) => `${i}. ${r.title}`).join("\n");

  let parsed = {};
  try {
    const { content } = await chatCompletion(provider, {
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.6,
      maxTokens: 600,
      jsonMode: true,
    });
    parsed = JSON.parse(content.replace(/<think>[\s\S]*?<\/think>/gi, "").match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    parsed = {};
  }
  const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  const out = [];
  const usedUrls = new Set();
  for (const it of ideas) {
    const r = items[it.index];
    if (!r || usedUrls.has(r.url)) continue;
    usedUrls.add(r.url);
    const key = POST_ARCHETYPES[it.archetype] ? it.archetype : "story";
    out.push({
      title: r.title,
      url: r.url,
      archetype: key,
      archetypeLabel: POST_ARCHETYPES[key].label,
      angle: String(it.angle || "").slice(0, 300),
    });
    if (out.length >= count) break;
  }
  return out;
}

// Generate several distinct LinkedIn post drafts grounded in source material
// (e.g. extracted PDF text), all in the resolved tone. Returns string[].
export async function generatePostsFromSource({
  sourceText, tone, count = 3, audience, language, length, exemplars, loraModel, stance, preferOpenAI, modelOverride, strict = false, archetype,
} = {}) {
  // Provider routing: public material (news/URL) prefers OpenAI for quality;
  // confidential uploads keep generation on the on-prem cluster (sovereignty).
  let provider = preferOpenAI ? publicProvider() || sourceProvider() : sourceProvider();
  if (!provider) {
    throw new Error("No LLM is configured. Set DGX_BASE_URL/DGX_API_KEY (on-prem) or OPENAI_API_KEY.");
  }
  // Apply the per-author fine-tuned model for whichever provider we landed on.
  if (provider.name?.startsWith("DGX") && loraModel) provider = { ...provider, model: loraModel };
  else if (provider.name === "OpenAI" && modelOverride) provider = { ...provider, model: modelOverride };

  const source = String(sourceText || "").trim();
  if (source.length < 40) {
    throw new Error("The content source has too little text to generate from.");
  }
  const n = Math.max(1, Math.min(7, parseInt(count, 10) || 3));
  const target = lengthTarget(length);

  // Read the topic only to decide HOW to write it (respectful tone for sensitive
  // subjects). We never refuse a topic — every source produces a post.
  const assessment = await assessTopic(provider, { sourceText: source, voiceInstruction: resolveTone(tone), exemplars, strict });
  const sensitive = assessment.sensitive;
  const effStance = sensitive ? "" : stance; // never apply a provocative stance to a tragedy

  let voiceSystem = buildSystemPrompt(resolveTone(tone), audience, language ? languageName(language) : null, target, exemplars);
  const arch = resolveArchetype(archetype);
  if (arch) voiceSystem += `\nFORMAT (post archetype): ${arch}`;
  const sourceRules = [
    "Use the SOURCE MATERIAL below. Ground every claim, number, name, and quote strictly in it; never invent facts.",
    !sensitive && resolveStance(effStance)
      ? `Angle: ${resolveStance(effStance)} This is the author's commentary/opinion, not a neutral summary.`
      : "",
    !sensitive && !resolveStance(effStance) && assessment.angle ? `Angle: ${assessment.angle}` : "",
    ...(sensitive ? SENSITIVITY_RULES : []),
    "Write exactly ONE LinkedIn post.",
  ].filter(Boolean).join("\n");

  // eslint-disable-next-line no-console
  console.log(`[ai] source generation via ${provider.name} (${provider.model}) x${n}`);

  // One request per post — reliable count, and we steer each toward a fresh
  // angle by telling it which openings are already taken.
  const out = [];
  const priorHooks = [];
  for (let i = 0; i < n; i++) {
    const distinct = priorHooks.length
      ? `\nTake a DIFFERENT angle from these already-used openings: ${priorHooks.join(" / ")}`
      : "";
    const system = `${voiceSystem}\n\n${sourceRules}${distinct}`;
    const user = `SOURCE MATERIAL:\n\n${source.slice(0, 40000)}\n\nWrite one LinkedIn post now.`;
    let body = await draftPost(provider, { system, user, targetChars: target, temperature: 0.9 }).catch(() => "");
    if (!body) continue;
    if (QUALITY) {
      body = await refineDraft(provider, { draft: body, voiceSystem, targetChars: target, grounded: true });
      body = await humanizeDraft(provider, { draft: body, voiceSystem, targetChars: target });
    }
    body = body.slice(0, MAX_POST_LENGTH);
    priorHooks.push(body.split("\n")[0].slice(0, 60));
    const tags = await generateHashtags({ text: body, provider, language, sensitive });
    out.push(appendHashtags(body, tags));
  }
  if (!out.length) throw new Error(`${provider.name} returned no usable posts.`);
  return out;
}

// Analyze example posts and distill a reusable tone-of-voice instruction that
// the generator can later use verbatim. Returns a concise style brief.
export async function learnToneFromExamples(samples) {
  const provider = publicProvider();
  if (!provider) {
    throw new Error("No public LLM is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  }
  const text = String(samples || "").trim();
  if (text.length < 80) {
    throw new Error("Paste at least one full example post (a bit more text) to learn a tone.");
  }

  const systemPrompt = [
    "You are a writing-style analyst. You are given one or more real LinkedIn posts written by the same person.",
    "Produce a precise, reusable TONE-OF-VOICE BRIEF that another writer could follow to reproduce this exact voice on new topics.",
    "Capture concretely: sentence length and rhythm, hook/opening style, vocabulary and register (formal/casual), use of first vs second person, emoji usage, hashtag habits, line-break/formatting patterns, punctuation quirks, and how posts typically close (CTA, question, etc.).",
    "Write the brief as direct instructions to the writer (imperative voice). Do NOT summarize the topics or quote the posts. Do NOT include a preamble. 120-220 words.",
  ].join("\n");

  const { content } = await chatCompletion(provider, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Here are the example posts:\n\n${text.slice(0, 12000)}` },
    ],
    temperature: 0.4,
    maxTokens: 600,
  });
  return content.slice(0, 4000);
}
