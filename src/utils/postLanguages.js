// Languages a post can be written in (independent of the app's UI language).
// `name` is the English name used in AI prompts; `label` is shown in the picker.
export const POST_LANGUAGES = [
  { code: "en", name: "English", label: "English" },
  { code: "de", name: "German", label: "German (Deutsch)" },
  { code: "es", name: "Spanish", label: "Spanish (Español)" },
  { code: "fr", name: "French", label: "French (Français)" },
  { code: "pt", name: "Portuguese", label: "Portuguese (Português)" },
  { code: "it", name: "Italian", label: "Italian (Italiano)" },
  { code: "nl", name: "Dutch", label: "Dutch (Nederlands)" },
  { code: "pl", name: "Polish", label: "Polish (Polski)" },
  { code: "uk", name: "Ukrainian", label: "Ukrainian (Українська)" },
  { code: "sv", name: "Swedish", label: "Swedish (Svenska)" },
];

const BY_CODE = new Map(POST_LANGUAGES.map((l) => [l.code, l]));

// Validate/clamp an incoming language code to a supported one (default "en").
export function normalizePostLanguage(code) {
  return BY_CODE.has(code) ? code : "en";
}

// English name for a code, for AI prompts ("Write in <name>.").
export function languageName(code) {
  return (BY_CODE.get(code) || BY_CODE.get("en")).name;
}
