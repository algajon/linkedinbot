// Target post lengths (in characters) for AI generation. These steer the model
// to express the same idea more or less concisely — not a hard truncation.
export const POST_LENGTHS = [
  { key: "short", chars: 300 },
  { key: "medium", chars: 600 },
  { key: "long", chars: 1200 },
];

const BY_KEY = new Map(POST_LENGTHS.map((l) => [l.key, l]));

export function normalizePostLength(key) {
  return BY_KEY.has(key) ? key : "medium";
}

// Target character count for a length key (default: medium).
export function lengthTarget(key) {
  return (BY_KEY.get(key) || BY_KEY.get("medium")).chars;
}
