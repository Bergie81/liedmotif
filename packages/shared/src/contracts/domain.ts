// Domain vocabularies the API contracts need that are NOT state-machine literals.
//
// The ones that mirror a DB `pgEnum` (feedback type, persisted playback event
// type, vocal mode, provider type) are declared here and held equal to the live
// `pgEnum.enumValues` by a test, same as the state literals, so they can never
// drift.
//
// `ENERGY_LEVELS` and the playback REPORT types are contract-only (energy is
// stored as free `text`, and `position` is a live-only report that is never
// persisted as a row), so they mirror no `pgEnum` by design.

/**
 * Audit-trail feedback actions (mirrors `feedback_type`). Deliberately has NO
 * `like` (positive signal is inaction — there is no Like button and no
 * `like` feedback type). `skip` is the soft-negative; `dislike` is the
 * reroll/reject; save/favorite (+ inverses) are retention.
 */
export const FEEDBACK_TYPES = [
  'save',
  'unsave',
  'favorite',
  'unfavorite',
  'dislike',
  'skip',
] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/**
 * Playback events that ARE persisted as `playback_events` rows (mirrors
 * `playback_event_type`). The periodic `position` ping is intentionally absent —
 * it updates live session fields only.
 */
export const PERSISTED_PLAYBACK_EVENT_TYPES = ['started', 'ended', 'skipped', 'failed'] as const;
export type PersistedPlaybackEventType = (typeof PERSISTED_PLAYBACK_EVENT_TYPES)[number];

/**
 * What a client may report via `reportPlaybackState`: the four persisted event
 * types PLUS the live-only `position` ping (which never creates a row). Contract-
 * level only — `position` is not a DB enum value.
 */
export const PLAYBACK_REPORT_TYPES = ['started', 'position', 'ended', 'skipped', 'failed'] as const;
export type PlaybackReportType = (typeof PLAYBACK_REPORT_TYPES)[number];

/** Instrumental by default, vocals opt-in (mirrors `vocal_mode`). */
export const VOCAL_MODES = ['instrumental', 'vocal'] as const;
export type VocalMode = (typeof VOCAL_MODES)[number];

/** Structured-control energy levels. Contract-only (`tracks.energy` is free text). */
export const ENERGY_LEVELS = ['low', 'medium', 'high'] as const;
export type EnergyLevel = (typeof ENERGY_LEVELS)[number];

/**
 * Voice (gender) picks for VOCAL sessions. Contract-only: "Any" is represented as
 * omission (like the Auto picks), so the vocabulary carries only explicit picks.
 */
export const VOICE_GENDERS = ['female', 'male'] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];

/**
 * Session-language picks: canonical English names the generation pipeline may
 * carry (each must stay on the provider-side `sanitizeLanguage` allowlist, since
 * the value reaches the music prompt as a "<language> vocals" tag and steers
 * title language). Contract-only — "Auto Detect" is represented as omission, so
 * the vocabulary carries only explicit picks. Display order is this order:
 * English pinned first, the rest A–Z.
 */
export const SESSION_LANGUAGES = [
  'English',
  'Arabic',
  'Chinese',
  'Czech',
  'Dutch',
  'French',
  'German',
  'Greek',
  'Hindi',
  'Indonesian',
  'Italian',
  'Japanese',
  'Korean',
  'Norwegian',
  'Polish',
  'Portuguese',
  'Romanian',
  'Russian',
  'Spanish',
  'Swedish',
  'Turkish',
  'Ukrainian',
  'Vietnamese',
] as const;
export type SessionLanguage = (typeof SESSION_LANGUAGES)[number];

/** Provider category for `validateProvider` (mirrors `provider_type`). */
export const PROVIDER_TYPES = ['music', 'llm', 'image', 'storage'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * The concrete preset art-direction lanes — every lane a grammar exists for.
 * Both `auto` (vibe-matched pick) and `random` (uniform roll) resolve onto
 * this pool, so it is the single list to grow when a new lane ships.
 */
export const COVER_STYLE_PRESETS = ['poster_art', 'photographic', 'minimal', 'drawing'] as const;
export type CoverStylePreset = (typeof COVER_STYLE_PRESETS)[number];

/** The OpenRouter image model a generated cover uses when neither `IMAGE_MODEL`
 *  nor the model saved with the image key names one; the UI's model-field default. */
export const OPENROUTER_DEFAULT_COVER_MODEL = 'google/gemini-3.1-flash-image';

/**
 * The one cover thumbnail edge the byte route serves (`?w=`): list/grid tiles
 * render at 42–64 CSS px, so 160 covers ≥2.5× DPR while cutting the 1024²
 * original's bytes by ~30×. A fixed vocabulary — the route ignores other
 * widths — so the rendition cache stays one file per cover.
 */
export const COVER_THUMBNAIL_EDGE = 160;

/**
 * Persisted generated-cover art-direction lanes (mirrors `cover_style`).
 * `auto` lets the cover prompt pipeline pick the lane from the Session intent +
 * Style Snapshot; the presets steer style, never subject. Deliberately no
 * `3d_object` (too generic for album art) and no Like-button-style growth:
 * the cover-art UX doc pins this set.
 */
export const COVER_STYLES = ['auto', ...COVER_STYLE_PRESETS, 'custom'] as const;
export type CoverStyle = (typeof COVER_STYLES)[number];

/** Narrow an untrusted string to one of the given domain literals, or null —
 *  for values crossing a permissive boundary (JSONB snapshots, free-form
 *  tags) into a typed contract without a cast. */
export function narrowTo<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * What the create card's `Cover style` dropdown offers, in render order
 * (`Auto` first, `Custom` last). `random` is choice-only vocabulary: Start
 * Session resolves it to a persisted `CoverStyle` (a preset, or `custom` when
 * a Custom definition is saved), so it never reaches `cover_style`.
 * `custom` is authoritative and persisted with its private definition.
 */
export const COVER_STYLE_CHOICES = ['auto', 'random', ...COVER_STYLE_PRESETS, 'custom'] as const;
export type CoverStyleChoice = (typeof COVER_STYLE_CHOICES)[number];

/**
 * The Session Guardrails' domain defaults, on the same
 * 0–1 float scale the contract carries: how strictly the music model honors the
 * compiled style, and how far it may deviate into the experimental. The one
 * source both the create card's sliders (which render them ×100) and the
 * server-side derivation read, so a slider left untouched and an intent that
 * omits the field mean the same music. `DEFAULT_NOVELTY` deliberately stays far
 * below the provider's experimental range.
 */
export const DEFAULT_STYLE_STRENGTH = 0.65;
export const DEFAULT_NOVELTY = 0.3;

/** Longest accepted Avoid text — the verbatim user half of the compiled negative
 *  tags, so it must stay short enough to ride a provider request alongside the
 *  system terms. */
export const MAX_SESSION_AVOID_LENGTH = 500;

/** Longest accepted `Custom style` cover definition (a style hint, never the final prompt). */
export const MAX_COVER_STYLE_HINT_LENGTH = 240;

/** Bound for the regenerate modal's free-text art direction (guidance). */
export const MAX_COVER_GUIDANCE_LENGTH = 500;

/**
 * The listener-profile fields (Settings → Profile) the text LLM may see — never
 * the email. General context for session/track naming; for vocal sessions the
 * model organizes a coherent group of request-relevant details into the snapshot's
 * compact lyric notes (`lyricContext`). Produced by `@liedmotif/db` (`getListenerContext`),
 * consumed by `@liedmotif/providers` (`LlmProvider`); lives here so the two never drift.
 * Private prompt data: callers must not log names, locations, or Person About values.
 */
export interface ListenerContext {
  name?: string;
  city?: string;
  country?: string;
  /** Exactly named People whose About may inform lyricContext only. */
  people?: Array<{ name: string; about: string }>;
}
