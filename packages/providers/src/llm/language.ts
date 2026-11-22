// Request-language canonicalization for the vocal-language tag, and for the
// language the Assistant is told to answer in (`readMessageLanguage`).
//
// The detected language is appended to every vocal track's provider prompt
// (`buildTrackPrompt` → "<language> vocals"), so it must never
// carry free text: a syntactic check is not enough ("German exactly like
// Adele" is all letters). `sanitizeLanguage` therefore canonicalizes against an
// ALLOWLIST of language names — anything else is dropped to '' (no tag,
// provider default). The expansion/fallback prompts ask for an English name,
// so the allowlist is keyed on those, plus common native self-names a chatty
// or non-English model may reply with.

/** Canonical language names the vocal tag may carry (matched case-insensitively). */
const CANONICAL_LANGUAGES = [
  'English',
  'German',
  'Swiss German',
  'French',
  'Spanish',
  'Italian',
  'Portuguese',
  'Brazilian Portuguese',
  'Dutch',
  'Swedish',
  'Norwegian',
  'Danish',
  'Finnish',
  'Icelandic',
  'Polish',
  'Czech',
  'Slovak',
  'Hungarian',
  'Romanian',
  'Bulgarian',
  'Serbian',
  'Croatian',
  'Slovenian',
  'Greek',
  'Turkish',
  'Russian',
  'Ukrainian',
  'Arabic',
  'Hebrew',
  'Persian',
  'Hindi',
  'Urdu',
  'Bengali',
  'Tamil',
  'Telugu',
  'Punjabi',
  'Japanese',
  'Korean',
  'Chinese',
  'Mandarin',
  'Mandarin Chinese',
  'Cantonese',
  'Thai',
  'Vietnamese',
  'Indonesian',
  'Malay',
  'Filipino',
  'Tagalog',
  'Swahili',
  'Afrikaans',
  'Catalan',
  'Galician',
  'Basque',
  'Welsh',
  'Irish',
  'Scottish Gaelic',
  'Estonian',
  'Latvian',
  'Lithuanian',
  'Belarusian',
  'Albanian',
  'Macedonian',
  'Bosnian',
  'Maltese',
  'Luxembourgish',
  'Armenian',
  'Georgian',
  'Azerbaijani',
  'Kazakh',
  'Uzbek',
  'Mongolian',
  'Nepali',
  'Sinhala',
  'Khmer',
  'Lao',
  'Burmese',
  'Kurdish',
  'Pashto',
  'Marathi',
  'Gujarati',
  'Malayalam',
  'Kannada',
  'Odia',
  'Amharic',
  'Somali',
  'Hausa',
  'Yoruba',
  'Igbo',
  'Zulu',
  'Xhosa',
] as const;

/** Native self-names a model may answer with despite the "English name" ask. */
const NATIVE_ALIASES: Record<string, string> = {
  deutsch: 'German',
  schweizerdeutsch: 'Swiss German',
  français: 'French',
  francais: 'French',
  español: 'Spanish',
  espanol: 'Spanish',
  italiano: 'Italian',
  português: 'Portuguese',
  portugues: 'Portuguese',
  nederlands: 'Dutch',
  svenska: 'Swedish',
  norsk: 'Norwegian',
  dansk: 'Danish',
  suomi: 'Finnish',
  polski: 'Polish',
  čeština: 'Czech',
  cestina: 'Czech',
  magyar: 'Hungarian',
  română: 'Romanian',
  romana: 'Romanian',
  türkçe: 'Turkish',
  turkce: 'Turkish',
  русский: 'Russian',
  українська: 'Ukrainian',
  العربية: 'Arabic',
  עברית: 'Hebrew',
  हिन्दी: 'Hindi',
  日本語: 'Japanese',
  한국어: 'Korean',
  中文: 'Chinese',
};

const LANGUAGE_BY_KEY: ReadonlyMap<string, string> = new Map([
  ...CANONICAL_LANGUAGES.map((name) => [name.toLowerCase(), name] as const),
  ...Object.entries(NATIVE_ALIASES),
]);

/**
 * Canonicalize a proposed request language wherever one enters the system
 * (schema parse of a model reply / stored jsonb, the detection fallback).
 * Surrounding quotes/periods from a chatty reply are stripped, whitespace
 * collapsed, then the value must resolve through the allowlist — an unknown or
 * injected value yields '' rather than ever reaching the provider prompt.
 */
export function sanitizeLanguage(value: string): string {
  const key = value
    .trim()
    .replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return LANGUAGE_BY_KEY.get(key) ?? '';
}
