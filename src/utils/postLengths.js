import { MAX_POST_LENGTH } from "./validation.js";

// Target post lengths (in characters) for AI generation. These steer the model
// to express the same idea more or less concisely — not a hard truncation.
export const POST_LENGTHS = [
  { key: "short", chars: 300 },
  { key: "medium", chars: 600 },
  { key: "long", chars: 1200 },
];

const BY_KEY = new Map(POST_LENGTHS.map((l) => [l.key, l]));
const MIN_CHARS = 120;

export function normalizePostLength(key) {
  return BY_KEY.has(key) ? key : "medium";
}

// Resolve a length input to a character target. Accepts a preset key
// ("short"/"medium"/"long") OR a raw number for a custom target; clamped to a
// sane range so it can't blow past LinkedIn's limit or be uselessly tiny.
export function lengthTarget(value) {
  if (value != null && !BY_KEY.has(value)) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return Math.max(MIN_CHARS, Math.min(MAX_POST_LENGTH, n));
  }
  return (BY_KEY.get(value) || BY_KEY.get("medium")).chars;
}
