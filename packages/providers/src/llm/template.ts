// Deterministic no-LLM producers: structured controls compile to a
// Style Snapshot via a fixed template, and a free-text intent compiles via the
// prompt passthrough — so the create flow always works without a configured
// text LLM. Per-track variety comes from rotating hidden seed parameters over
// the validated snapshot — there is NO LLM call per buffered track. Track
// titles / artist names are cosmetic and derived deterministically here, so they
// never block playback, buffering, or provider submission.

import { DEFAULT_NOVELTY, DEFAULT_STYLE_STRENGTH, hash32, normalizeTerm } from '@liedmotif/shared';
import { sanitizeLanguage } from './language';
import {
  clampGuardrailLevel,
  sanitizeUserAvoid,
  DEFAULT_BASE_SEED,
  ENERGY_LEVELS,
  MAX_STYLE_PROMPT_LENGTH,
  sanitizeVoiceGender,
  sessionStyleSnapshotSchema,
  VOCAL_MODES,
  type EnergyLevel,
  type SessionStyleSnapshot,
  type VocalMode,
  type VoiceGender,
} from './snapshot';

/**
 * The Session Guardrails as an intent carries them: the
 * two levels on the domain 0–1 scale, and the Avoid text verbatim. Every field
 * is optional — `applyGuardrails` resolves the domain defaults. They never reach
 * the compiled style text (the levels are provider parameters and the Avoid text
 * becomes negative terms), so both producers ignore them and the stamping runs
 * afterwards.
 */
export interface SessionGuardrails {
  styleStrength?: number;
  novelty?: number;
  avoid?: string;
}

/** Predefined structured controls a user picks (compiled with no LLM). A flat
 * type alias — not an interface, and not an intersection with
 * `SessionGuardrails` — because only a plain object-literal alias gets the
 * implicit index signature that keeps it assignable to the db layer's
 * index-signatured `StructuredControls` when a route persists it. */
export type StructuredControls = {
  activity?: string;
  mood?: string;
  energy?: EnergyLevel;
  genres?: string[];
  vocal?: VocalMode;
  /** Voice (gender) pick for vocal sessions; omitted = Any. */
  voice?: VoiceGender;
  /** Sing with the user's own voice profile (vocal sessions only). */
  ownVoice?: boolean;
  /** Language for titles and vocals (canonical English name); omitted = unset. */
  language?: string;
  /** The Session Guardrails this intent branch carries (see `SessionGuardrails`). */
  styleStrength?: number;
  novelty?: number;
  avoid?: string;
};

/**
 * The user's explicit fine-tune picks riding a free-text intent (the describe
 * tab): each present field is authoritative over whatever the request's words
 * suggest, enforced deterministically on the expanded snapshot — never by
 * trusting the model. Omission means Auto/Any (the model decides).
 */
export interface StylePicks {
  genres?: readonly string[];
  energy?: EnergyLevel;
  vocal?: VocalMode;
  voice?: VoiceGender;
  /** Sing with the user's own voice profile (honored on vocal results only). */
  ownVoice?: boolean;
  /** Language for titles and vocals (canonical English name). Unlike `voice` it
   * is NOT vocal-gated: an instrumental session's titles follow it too. */
  language?: string;
  /** The Avoid guardrail's verbatim text. It rides here so the expansion can be
   * told not to write the avoided traits into the style prose; the guardrail
   * levels never do — they are provider parameters, and naming them in prose
   * would apply them twice. */
  avoid?: string;
}

/** Compiled per-track generation parameters (the music-provider input shape). */
export interface TrackPromptParams {
  /** Compiled track DESCRIPTION (non-custom mode's `prompt`; never lyrics). */
  prompt: string;
  /** Compiled custom-mode style — the same description (base + variation + BPM/key). */
  style: string;
  title: string;
  /** Hidden seed parameter for this track's deterministic variation. */
  seed: number;
  instrumental: boolean;
  /** Negative terms joined for the provider, or undefined when there are none. */
  negativeTags?: string;
}

/** Cosmetic track metadata; never blocks playback/buffering. */
export interface TrackMetadata {
  title: string;
  artistName: string;
}

/** Subtle per-track modifiers, rotated by track index for controlled variety. */
const TRACK_VARIATIONS = [
  'warm analog texture',
  'crisp modern mix',
  'subtle background variation',
  'deeper low end',
  'brighter top end',
  'spacious reverb tail',
];

const ARTIST_ADJECTIVES = [
  'Velvet',
  'Neon',
  'Hollow',
  'Amber',
  'Quiet',
  'Distant',
  'Golden',
  'Paper',
];
const ARTIST_NOUNS = ['Circuit', 'Harbor', 'Meadow', 'Signal', 'Tide', 'Lantern', 'Drift', 'Echo'];

/** Pick an element by rotating index, wrapping for any (incl. negative) index. */
function pick<T>(values: readonly T[], index: number): T {
  return values[((index % values.length) + values.length) % values.length]!;
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// --- Frozen blend parameters --------------------------------------------------
// A Session freezes ONE BPM + key so consecutive Tracks beat-match and blend for
// free; variety comes from the hidden seed parameters, not BPM/key drift. The
// derivation is deterministic — the same controls always freeze the same values.

/** Tempo floor per energy level; a genre nudge spreads same-energy sessions. */
const ENERGY_BASE_BPM: Record<EnergyLevel, number> = {
  low: 82,
  medium: 110,
  high: 128,
};

/** Key pool a Session freezes one of for harmonic mixing. */
const MUSICAL_KEYS = [
  'A minor',
  'C major',
  'D minor',
  'F major',
  'E minor',
  'G major',
  'B minor',
  'D major',
  'C minor',
  'A major',
  'E major',
  'G minor',
] as const;

/**
 * Freeze ONE BPM + key for a Session from its energy and genre. Energy
 * sets the tempo floor; a genre-derived nudge (±3) keeps two same-energy sessions
 * from always sharing a BPM. No randomness — same inputs, same BPM/key.
 */
function deriveFrozenBpmKey(
  energy: EnergyLevel,
  genreTags: readonly string[],
): { bpm: number; key: string } {
  const fingerprint = genreTags.join(',');
  const bpm = ENERGY_BASE_BPM[energy] + (hash32(`bpm#${energy}#${fingerprint}`) % 7) - 3;
  const key = pick(MUSICAL_KEYS, hash32(`key#${energy}#${fingerprint}`));
  return { bpm, key };
}

/**
 * The session's base hidden seed — Liedmotif's own
 * "seed," rotated per-track and bumped (`rerollSalt`) on a Dislike reroll. Deriving
 * it from a stable fingerprint keeps a given control set reproducible.
 */
function deriveBaseSeed(fingerprint: string): number {
  return hash32(`seed#${fingerprint}`);
}

/** Longest key a producer may freeze (fits e.g. "F sharp harmonic minor"). Anything
 *  longer is junk, and it would ride the per-track style TAIL — the part the
 *  cap-aware budget in `styleWithTail` promises always survives a provider clamp. */
const MAX_KEY_LENGTH = 24;

/**
 * Fill any unfrozen blend parameters on a snapshot. Used by the free-text
 * producers so EVERY session — not just the structured path — carries a frozen
 * BPM/key + seed, the precondition for blend-for-free. A model-provided BPM is
 * normalized to an integer (so the frozen value and the per-track style tag share
 * one source of truth) and a provided key is kept only when it is plausibly a short
 * musical key; an unset, blank, or overlong key is derived from the snapshot's own
 * energy/genre instead (an unbounded LLM-provided key would make the style tail
 * itself exceed a tight provider cap). The hidden seed is ALWAYS frozen from the
 * controls-derived `stylePrompt` (the one seed source), so the same controls
 * always freeze the same `baseSeed`; any existing reroll salt is preserved.
 */
export function freezeStyleParameters(snapshot: SessionStyleSnapshot): SessionStyleSnapshot {
  const derived = deriveFrozenBpmKey(snapshot.energy, snapshot.genreTags);
  const key = snapshot.key.trim();
  return {
    ...snapshot,
    bpm: snapshot.bpm != null ? Math.round(snapshot.bpm) : derived.bpm,
    key: key && key.length <= MAX_KEY_LENGTH ? key : derived.key,
    seedParameters: {
      ...snapshot.seedParameters,
      baseSeed: deriveBaseSeed(snapshot.stylePrompt),
    },
  };
}

/** Per-tag length cap so a single huge genre can't bloat the snapshot/title. */
const MAX_TAG_LENGTH = 60;

/** Keep only the non-empty normalized strings (each length-capped) from a loosely-typed array. */
function stringTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = normalizeTerm(item).slice(0, MAX_TAG_LENGTH);
    if (tag) tags.push(tag);
  }
  return tags;
}

/** Whether a negative term is the anti-vocals steer the instrumental compile adds. */
function isVocalsNegative(term: string): boolean {
  return /^vocals?$/i.test(term.trim());
}

/** A comma-separated list's non-empty segments, trimmed. The unit vocal-mode
 *  rewriting works on (so a compound genre like "instrumental hip hop" is never
 *  mangled word-by-word) and the unit the Avoid text parses into (so a trailing
 *  or doubled comma never ships as a blank negative tag). */
function commaSegments(text: string): string[] {
  return text
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function applyGenrePicks(
  snapshot: SessionStyleSnapshot,
  genres: readonly string[] | undefined,
): SessionStyleSnapshot {
  const picks = stringTags(genres);
  if (picks.length === 0) return snapshot;
  const picked = new Set(picks);
  const styleText = snapshot.stylePrompt.toLowerCase();
  const missing = picks.filter((pick) => !styleText.includes(pick));
  return {
    ...snapshot,
    genreTags: [...picks, ...snapshot.genreTags.filter((tag) => !picked.has(normalizeTerm(tag)))],
    stylePrompt: missing.length
      ? `${missing.join(', ')}, ${snapshot.stylePrompt}`.slice(0, MAX_STYLE_PROMPT_LENGTH)
      : snapshot.stylePrompt,
  };
}

/**
 * Force the picked vocal mode over the model's reading. Beyond the mode flag
 * (which drives the provider's `instrumental` switch), the contradicting style
 * text is rewritten and the vocal-only fields are kept consistent: instrumental
 * clears lyricContext/voiceGender (no lyrics exist) and steers away from vocals
 * via `negativeTerms`; vocal drops that steer. The language survives either
 * mode — it also steers title language, and the per-track vocal tail is
 * mode-gated (`vocalDescriptionTail`), so it can never leak into an
 * instrumental description.
 */
function applyVocalPick(
  snapshot: SessionStyleSnapshot,
  vocal: VocalMode | undefined,
): SessionStyleSnapshot {
  if (!vocal) return snapshot;
  if (vocal === 'vocal' && snapshot.vocalMode === 'vocal') {
    // A model that already obeyed the pick can still echo the instrumental
    // steer it was shown on an adjustment; it must not ride a vocal snapshot.
    return {
      ...snapshot,
      negativeTerms: snapshot.negativeTerms.filter((t) => !isVocalsNegative(t)),
    };
  }
  if (vocal === snapshot.vocalMode) return snapshot;
  if (vocal === 'vocal') {
    // Only the BARE "instrumental" tag is dropped — from the style (whole comma
    // segments) and from genreTags, with one predicate — so a compound genre
    // like "instrumental hip hop" is never mangled. Contradicting prose the
    // model wove into a longer segment stays; the provider's instrumental flag
    // and the appended vocal tag override it.
    const isBareInstrumental = (text: string) => text.trim().toLowerCase() === 'instrumental';
    const stripped = commaSegments(snapshot.stylePrompt)
      .filter((segment) => !isBareInstrumental(segment))
      .join(', ');
    return {
      ...snapshot,
      vocalMode: 'vocal',
      negativeTerms: snapshot.negativeTerms.filter((term) => !isVocalsNegative(term)),
      genreTags: snapshot.genreTags.filter((tag) => !isBareInstrumental(tag)),
      stylePrompt: (/vocal/i.test(stripped) ? stripped : `${stripped}, with vocals`).slice(
        0,
        MAX_STYLE_PROMPT_LENGTH,
      ),
    };
  }
  // The "with vocals" phrase can't be part of a genre name, so it is safe to
  // strip inside a segment; a segment left empty (or reduced to bare "vocals")
  // disappears with it.
  const stripped = commaSegments(snapshot.stylePrompt)
    .map((segment) => segment.replace(/\bwith vocals\b/gi, '').trim())
    .filter((segment) => segment && !isVocalsNegative(segment))
    .join(', ');
  return {
    ...snapshot,
    vocalMode: 'instrumental',
    negativeTerms: snapshot.negativeTerms.some(isVocalsNegative)
      ? snapshot.negativeTerms
      : [...snapshot.negativeTerms, 'vocals'],
    stylePrompt: (/\binstrumental\b/i.test(stripped)
      ? stripped
      : `${stripped}, instrumental`
    ).slice(0, MAX_STYLE_PROMPT_LENGTH),
    lyricContext: '',
    voiceGender: '',
    useOwnVoice: false,
  };
}

/**
 * Force the picked energy over the model's reading. The model's BPM reflected
 * ITS energy guess, so it is unfrozen (`bpm: null`) for `freezeStyleParameters`
 * to re-derive from the forced energy — and any stale "<level> energy" style
 * tag is rewritten to match (appended when the style never named one).
 */
function applyEnergyPick(
  snapshot: SessionStyleSnapshot,
  energy: EnergyLevel | undefined,
): SessionStyleSnapshot {
  if (!energy || energy === snapshot.energy) return snapshot;
  const energyTag = /\b(low|medium|high) energy\b/gi;
  const stylePrompt = snapshot.stylePrompt.match(energyTag)
    ? snapshot.stylePrompt.replace(energyTag, `${energy} energy`)
    : `${snapshot.stylePrompt}, ${energy} energy`;
  return {
    ...snapshot,
    energy,
    bpm: null,
    stylePrompt: stylePrompt.slice(0, MAX_STYLE_PROMPT_LENGTH),
  };
}

/**
 * Deterministically enforce the user's explicit fine-tune picks (the describe
 * tab) on a free-text producer's snapshot. Genre picks lead `genreTags` (the
 * model's own tags keep the trailing slots, deduped) and any pick the style
 * text doesn't already mention is prepended — the same genres-lead order the
 * structured template compiles. Energy and vocal picks override the model's
 * reading of the words (see `applyEnergyPick`/`applyVocalPick`), and a Voice
 * pick lands as `voiceGender` on vocal results only. The expansion prompt only
 * GUIDES the model toward the picks; this is the guarantee, so they reliably
 * shape what the music provider receives. Must run BEFORE
 * `freezeStyleParameters` so the picks join the frozen BPM/key fingerprint
 * exactly like tune-tab controls. No picks → the snapshot is returned unchanged.
 */
export function applyStylePicks(
  snapshot: SessionStyleSnapshot,
  picks: StylePicks | undefined,
): SessionStyleSnapshot {
  if (!picks) return snapshot;
  let result = applyGenrePicks(snapshot, picks.genres);
  result = applyVocalPick(result, picks.vocal);
  result = applyEnergyPick(result, picks.energy);
  if (picks.voice && result.vocalMode === 'vocal') {
    result = { ...result, voiceGender: picks.voice };
  }
  // The own-voice opt-in is honored on vocal results only, and it clears the
  // gender tag — the user's own voice defines the singer, so a "<gender>
  // vocals" style tag would only fight it.
  if (picks.ownVoice !== undefined) {
    const useOwnVoice = picks.ownVoice && result.vocalMode === 'vocal';
    result = { ...result, useOwnVoice, ...(useOwnVoice ? { voiceGender: '' as const } : {}) };
  }
  // A language pick overrides the producer's detected language on EITHER vocal
  // mode (it steers titles too). Off-allowlist input is dropped rather than
  // enforced — it must never wipe a good detected value with ''.
  const language = picks.language ? sanitizeLanguage(picks.language) : '';
  if (language) {
    result = { ...result, language };
  }
  return result;
}

/**
 * The compiled negative terms: the system terms (the instrumental `vocals`
 * steer, whatever the expansion produced) FIRST, then the user's Avoid terms.
 * Order is load-bearing — the terms reach the provider as one bounded field, so
 * a truncation must eat the user's tail, never the system steer. Deduped
 * case-insensitively, keeping the first spelling.
 */
function mergeNegativeTerms(systemTerms: readonly string[], avoid: string | undefined): string[] {
  const merged = [...systemTerms];
  const seen = new Set(merged.map(normalizeTerm));
  for (const term of commaSegments(avoid ?? '')) {
    const key = normalizeTerm(term);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(term);
  }
  return merged;
}

/**
 * Drop the terms a PREVIOUS Avoid text contributed, so editing Avoid REPLACES
 * the user's half of the negative terms instead of accumulating every spelling
 * the session ever avoided. It matters on the adjustment path: the running
 * snapshot's merged terms are shown to the expansion, which echoes them back.
 * The instrumental `vocals` steer is exempt — it is a system term first, and a
 * user who once typed it into Avoid must not be able to unsuppress vocals by
 * clearing the box. Nothing else distinguishes a producer's own negative term
 * from a user's, so an expansion-authored term that happens to match the old
 * Avoid text goes with it: dropping what the user just stopped avoiding beats
 * accumulating every spelling forever.
 */
function withoutPreviousAvoid(
  terms: readonly string[],
  previousAvoid: string | undefined,
  instrumental: boolean,
): string[] {
  const removed = new Set(commaSegments(previousAvoid ?? '').map(normalizeTerm));
  if (removed.size === 0) return [...terms];
  return terms.filter(
    (term) => !removed.has(normalizeTerm(term)) || (instrumental && isVocalsNegative(term)),
  );
}

/**
 * Stamp the Session Guardrails onto a produced snapshot.
 * Deterministic and always applied, on both producer paths: the intent's value
 * wins, else the domain default — so from creation forward the snapshot is
 * self-contained and a Dislike reroll compiles the same guardrails as its
 * siblings. The Avoid text is stored verbatim as the editable identity AND
 * merged into `negativeTerms`; the levels never touch any prompt text, since
 * the music adapter sends them as parameters.
 *
 * `previousAvoid` is the Avoid text of the snapshot being ADJUSTED (Change
 * Vibe), whose terms are cleared out before the new ones merge.
 */
export function applyGuardrails(
  snapshot: SessionStyleSnapshot,
  guardrails: SessionGuardrails | undefined,
  previousAvoid?: string,
): SessionStyleSnapshot {
  const userAvoid = sanitizeUserAvoid(guardrails?.avoid ?? '');
  const systemTerms = withoutPreviousAvoid(
    snapshot.negativeTerms,
    previousAvoid,
    snapshot.vocalMode === 'instrumental',
  );
  return {
    ...snapshot,
    styleStrength: clampGuardrailLevel(guardrails?.styleStrength ?? DEFAULT_STYLE_STRENGTH),
    novelty: clampGuardrailLevel(guardrails?.novelty ?? DEFAULT_NOVELTY),
    userAvoid,
    negativeTerms: mergeNegativeTerms(systemTerms, userAvoid),
  };
}

/** Every snapshot field the Guardrail stamp owns — the patch a seeded Session
 *  overlays, declared beside the stamp so the two cannot drift apart. */
export type InheritedGuardrails = Pick<
  SessionStyleSnapshot,
  'styleStrength' | 'novelty' | 'userAvoid' | 'negativeTerms'
>;

/**
 * The Guardrails a NEW Session inherits from the snapshot it was seeded FROM
 * (More Like This): the source's levels and Avoid text are part of what "this"
 * sounds like, so they carry over verbatim, and a pre-guardrails source falls to
 * the domain defaults. Re-stamping is what merges the inherited Avoid into
 * `negativeTerms`; on an already-merged source the merge dedupes, so it is a
 * no-op.
 */
export function inheritedGuardrails(snapshot: SessionStyleSnapshot): InheritedGuardrails {
  const { styleStrength, novelty, userAvoid, negativeTerms } = applyGuardrails(snapshot, {
    styleStrength: snapshot.styleStrength,
    novelty: snapshot.novelty,
    avoid: snapshot.userAvoid,
  });
  return { styleStrength, novelty, userAvoid, negativeTerms };
}

/** Trim a value to a bounded string, or `''` for any non-string. */
function boundedText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_STYLE_PROMPT_LENGTH) : '';
}

/** Coerce a value to one of `allowed`, falling back to `fallback` when out-of-set. */
function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** A minimal valid snapshot, used only if (somehow) the composed one fails to parse.
 *  Still blend-ready: `freezeStyleParameters` fills a concrete BPM/key + seed. */
const FALLBACK_SNAPSHOT: SessionStyleSnapshot = freezeStyleParameters({
  stylePrompt: 'instrumental ambient, medium energy',
  negativeTerms: ['vocals'],
  mood: '',
  activity: '',
  genreTags: [],
  vocalMode: 'instrumental',
  energy: 'medium',
  titleScheme: 'Session',
  title: '',
  trackTitles: [],
  lyricContext: '',
  language: '',
  voiceGender: '',
  useOwnVoice: false,
  safetyWarnings: [],
  bpm: null,
  key: '',
  seedParameters: {},
});

/**
 * TOTAL by contract: the no-LLM create path must ALWAYS produce a valid
 * snapshot and NEVER throw, even for malformed/untyped input. Inputs are coerced
 * (array-of-strings, bounded text, enum-or-default) and the result is `safeParse`d
 * with a minimal fallback. Callers still validate at their boundary as
 * defense-in-depth; this guarantees the core itself cannot throw.
 */
export function compileStructuredControls(controls?: StructuredControls): SessionStyleSnapshot {
  // The whole body is guarded so this is UNCONDITIONALLY total: even a pathological
  // input (a throwing getter / proxy trap) yields the fallback rather than throwing.
  try {
    const input = (controls ?? {}) as Partial<Record<keyof StructuredControls, unknown>>;
    const genreTags = stringTags(input.genres);
    const mood = boundedText(input.mood);
    const activity = boundedText(input.activity);
    const energy: EnergyLevel = coerceEnum(input.energy, ENERGY_LEVELS, 'medium');
    const vocalMode: VocalMode = coerceEnum(input.vocal, VOCAL_MODES, 'instrumental');
    // The Voice pick applies to vocal sessions only; it rides the per-track
    // vocal tail (like `language`), never the base style — no duplication.
    // "Use my voice" rides only vocal sessions, and it clears the gender tag —
    // the user's own voice defines the singer.
    const useOwnVoice = vocalMode === 'vocal' && input.ownVoice === true;
    const voiceGender =
      vocalMode === 'vocal' && !useOwnVoice && typeof input.voice === 'string'
        ? sanitizeVoiceGender(input.voice)
        : '';
    // The language rides both modes: the vocal tail consumes it on vocal
    // sessions, the naming call steers titles with it either way.
    const language = typeof input.language === 'string' ? sanitizeLanguage(input.language) : '';

    // Deterministic prompt template — order is fixed so the same controls always
    // compile to the same prompt.
    const parts: string[] = [];
    if (genreTags.length) parts.push(genreTags.join(', '));
    if (activity) parts.push(`for ${activity}`);
    if (mood) parts.push(`${mood} mood`);
    parts.push(`${energy} energy`);
    parts.push(vocalMode === 'vocal' ? 'with vocals' : 'instrumental');

    const snapshot = {
      // Clamp so free-text controls can never exceed the schema cap.
      stylePrompt: parts.join(', ').slice(0, MAX_STYLE_PROMPT_LENGTH),
      negativeTerms: vocalMode === 'instrumental' ? ['vocals'] : [],
      mood,
      activity,
      genreTags,
      vocalMode,
      energy,
      voiceGender,
      useOwnVoice,
      language,
      titleScheme: activity || genreTags[0] || 'Session',
      safetyWarnings: [],
    };
    const result = sessionStyleSnapshotSchema.safeParse(snapshot);
    // Freeze ONE BPM/key + seed per session, deterministically — the same
    // freeze path the free-text producers use, so every snapshot converges on it.
    return result.success ? freezeStyleParameters(result.data) : FALLBACK_SNAPSHOT;
  } catch {
    return FALLBACK_SNAPSHOT;
  }
}

// Filler that would make a weak track-title base ("Something Like A 3").
const TITLE_FILLER_WORDS = new Set([
  ...'a an the some something like for with my me i to of and in on at'.split(' '),
  ...'want music song songs playlist'.split(' '),
]);

/** The first few meaningful words of the request — the track-title base when no
 *  genre is picked, so two unpicked Sessions don't both number "Session 1". */
function titleSchemeFromWords(text: string): string | undefined {
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter(
    (word) => !TITLE_FILLER_WORDS.has(word.toLowerCase()),
  );
  return words.slice(0, 3).join(' ').slice(0, MAX_TAG_LENGTH) || undefined;
}

/**
 * Deterministic prompt passthrough: with NO text LLM
 * configured, a free-text intent compiles here — the user's words become the
 * style prompt AS WRITTEN (trimmed, clamped to the snapshot cap), with the
 * explicit fine-tune picks enforced by the same `applyStylePicks` that guards
 * the LLM expansion, and ONE frozen BPM/key + seed. Instrumental is
 * the app default, with the same anti-vocals steer the structured template
 * compiles. Nothing cosmetic or personal is filled — naming falls to the
 * deterministic scheme (`titleScheme` from the first genre pick, else the
 * request's first meaningful words), and
 * personalization stays LLM-gated.
 *
 * An ADJUSTMENT (Change Vibe) passes the running snapshot as `anchor`, and the
 * message replaces only the style words: every other facet — vocal mode, voice,
 * language, energy, lyric notes, the system negative terms, the frozen BPM/key —
 * starts from the anchor, as the LLM adjustment's do. The genres are applied
 * as a pick — the user's when one was made (it replaces the running genres),
 * the anchor's otherwise — because the style text is the only way a genre
 * reaches the music model. The explicit picks then win over the anchor; a
 * changed energy re-freezes the tempo, and going instrumental clears the
 * vocal-only fields. Own voice is never carried here: the caller re-sends it as
 * a pick so the voice profile is re-checked.
 *
 * TOTAL by contract, like `compileStructuredControls`: the no-LLM create path
 * must ALWAYS yield a valid snapshot and NEVER throw, even for malformed input.
 */
export function compilePromptPassthrough(
  prompt: string,
  picks?: StylePicks,
  anchor?: SessionStyleSnapshot,
): SessionStyleSnapshot {
  try {
    const stylePrompt = boundedText(prompt);
    const pickedGenres = stringTags(picks?.genres);
    const base = sessionStyleSnapshotSchema.safeParse(
      anchor
        ? {
            ...anchor,
            stylePrompt,
            genreTags: [],
            useOwnVoice: false,
            safetyWarnings: [],
            seedParameters: {},
          }
        : {
            stylePrompt,
            negativeTerms: ['vocals'],
            vocalMode: 'instrumental',
            titleScheme: pickedGenres[0] ?? titleSchemeFromWords(stylePrompt) ?? 'Session',
          },
    );
    if (!base.success) return FALLBACK_SNAPSHOT;
    const effectivePicks =
      anchor && pickedGenres.length === 0 ? { ...picks, genres: anchor.genreTags } : picks;
    return freezeStyleParameters(applyStylePicks(base.data, effectivePicks));
  } catch {
    return FALLBACK_SNAPSHOT;
  }
}

/**
 * Cosmetic metadata for the `trackIndex`-th track. With a creative title pool
 * (LLM-proposed on the snapshot — already clamped by the schema at parse) the
 * track takes the pool entry at its ordinal. The worker refills the pool before
 * a submit runs past it; when a refill was unavailable, an ordinal past the pool
 * repeats a pool title numbered by the ordinal ("Nightfall 14"), so no two
 * ordinals ever share a title.
 * Without a pool, the deterministic scheme numbers the base ("Focus 3").
 * `trackIndex` is a per-TRACK ordinal; callers that know only the provider-call
 * index use `deriveSiblingTrackTitles`.
 */
export function deriveTrackMetadata(snapshot: SessionStyleSnapshot, trackIndex = 0): TrackMetadata {
  const seed = hash32(`${snapshot.stylePrompt}#${trackIndex}#meta`);
  const artistName = `${pick(ARTIST_ADJECTIVES, seed)} ${pick(ARTIST_NOUNS, seed >>> 3)}`;
  const pool = snapshot.trackTitles;
  if (pool.length > 0) {
    if (trackIndex < pool.length) return { title: pool[trackIndex]!, artistName };
    // Numbered by ordinal, not by lap: the pool can grow between two calls, and
    // a lap number computed from its length would repeat across that growth.
    return { title: `${pool[trackIndex % pool.length]!} ${trackIndex + 1}`, artistName };
  }
  const base = titleCase(
    snapshot.titleScheme || snapshot.activity || snapshot.genreTags[0] || 'Untitled Session',
  );
  return { title: `${base} ${trackIndex + 1}`, artistName };
}

/**
 * Distinct display titles for the sibling tracks of ONE provider call (the music
 * provider yields several tracks per request — Suno: 2 — which would otherwise all
 * echo the single submitted title). Sibling `k` of request `requestIndex` gets the
 * per-track ordinal `requestIndex * siblingCount + k`, so titles stay distinct
 * within a call AND across a session's calls. `siblingCount` must be a per-request
 * CONSTANT (the requested track count) — never the count visible on one poll — so
 * every poll mints the same ordinals.
 */
export function deriveSiblingTrackTitles(
  snapshot: SessionStyleSnapshot,
  requestIndex: number,
  siblingCount: number,
): string[] {
  return Array.from(
    { length: siblingCount },
    (_, k) => deriveTrackMetadata(snapshot, requestIndex * siblingCount + k).title,
  );
}

/** Read a finite number from the hidden-seed record, else compute a fallback. */
function seedNumber(seed: Record<string, unknown>, key: string, fallback: () => number): number {
  const value = seed[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback();
}

/**
 * The per-track hidden seed. It flows SOLELY from
 * the snapshot's frozen `seedParameters` — the frozen `baseSeed` (+ a reroll
 * `rerollSalt`) and the track index. There is exactly one seed source: NO parallel
 * recomputation from `stylePrompt`. A validated snapshot always carries a numeric
 * `baseSeed` (the schema defaults one; producers derive it from the controls), so
 * the constant guard below only catches a hand-built snapshot with a junk baseSeed.
 */
function perTrackSeed(snapshot: SessionStyleSnapshot, trackIndex: number): number {
  const seed = snapshot.seedParameters;
  const baseSeed = seedNumber(seed, 'baseSeed', () => DEFAULT_BASE_SEED);
  const rerollSalt = seedNumber(seed, 'rerollSalt', () => 0);
  return hash32(`${baseSeed}#${trackIndex}#${rerollSalt}`);
}

/**
 * A frozen BPM/key pair formatted as a short style tag. Empty when
 * neither is set. Exported (beyond the snapshot-reading wrapper below) so the
 * reroll compiler can rebuild a stored style's tail from a request's persisted
 * `targetBpm`/`targetKey` — the same format `buildSessionStyle` appended when
 * the original request was submitted.
 */
export function frozenBpmKeyTag(
  bpm: number | null | undefined,
  key: string | null | undefined,
): string {
  const tags: string[] = [];
  if (bpm != null) tags.push(`${Math.round(bpm)} bpm`);
  if (key) tags.push(key);
  return tags.length ? `, ${tags.join(', ')}` : '';
}

/** The frozen BPM/key, formatted as a short style tag so it reaches the music
 *  provider with every per-track style. Empty until the pair is frozen.
 *  `freezeStyleParameters` already stored an integer BPM, so this just reads it. */
function frozenStyleSuffix(snapshot: SessionStyleSnapshot): string {
  return frozenBpmKeyTag(snapshot.bpm, snapshot.key);
}

/**
 * The VOCAL-only description tail (rides `styleWithTail`'s surviving part): ONE
 * merged "<gender> <language> vocals" style tag so the music model sings with the
 * picked voice in the language the user asked in, then the LLM-produced compact
 * lyric brief. '' for instrumental sessions (no lyrics exist) and for every field
 * the producer left unset.
 */
function vocalDescriptionTail(snapshot: SessionStyleSnapshot): string {
  if (snapshot.vocalMode !== 'vocal') return '';
  const voice = [snapshot.voiceGender, snapshot.language].filter(Boolean).join(' ');
  const voiceTag = voice ? `, ${voice} vocals` : '';
  const lyricTag = snapshot.lyricContext ? `. Lyric brief: ${snapshot.lyricContext}` : '';
  return voiceTag + lyricTag;
}

/**
 * Append `tail` to `base`, budgeting the BASE so the total stays within
 * `maxLength` (never above the snapshot cap) — the informative tail (variation,
 * BPM/key) must survive the tightest downstream clamp, not be what it cuts off.
 * Exported for the reroll compiler, which re-budgets a STORED style against the
 * submitting model's caps.
 */
export function budgetDescription(base: string, tail: string, maxLength: number): string {
  const budget = Math.min(maxLength, MAX_STYLE_PROMPT_LENGTH);
  return base.slice(0, Math.max(0, budget - tail.length)) + tail;
}

/** `budgetDescription` over a snapshot's style prompt. */
function styleWithTail(snapshot: SessionStyleSnapshot, tail: string, maxLength: number): string {
  return budgetDescription(snapshot.stylePrompt, tail, maxLength);
}

/**
 * The SESSION-frozen style: the snapshot's style plus the frozen BPM/key tail, with
 * NO per-track variation. This is the index-independent identity of what a session
 * submits — the buffer controller stores it on each generation request and compares
 * it against a policy-blocked job's stored style to decide whether a Change Vibe
 * has lifted the block. Per-track requests (`buildTrackPrompt`) additionally fold
 * in a seed-picked variation, so they must never be used for that comparison.
 */
export function buildSessionStyle(snapshot: SessionStyleSnapshot): string {
  return styleWithTail(snapshot, frozenStyleSuffix(snapshot), MAX_STYLE_PROMPT_LENGTH);
}

/**
 * `maxDescriptionLength` is the cap of the provider field that will carry the
 * compiled description (capability `maxStyleLength`/`maxPromptLength`), so the
 * budget happens HERE — where the base/tail structure is known — and the adapter's
 * boundary clamp never has to cut the variation or the frozen BPM/key.
 */
export function buildTrackPrompt(
  snapshot: SessionStyleSnapshot,
  trackIndex: number,
  maxDescriptionLength: number = MAX_STYLE_PROMPT_LENGTH,
): TrackPromptParams {
  const seed = perTrackSeed(snapshot, trackIndex);
  // The hidden seed picks the variation, so ANY seed change — a new track index or a
  // Dislike reroll's bumped rerollSalt — changes the compiled request (one seed
  // source). Rotating by raw index would silently ignore the reroll salt.
  const variation = pick(TRACK_VARIATIONS, seed);
  const negativeTags = snapshot.negativeTerms.length
    ? snapshot.negativeTerms.join(', ')
    : undefined;
  // ONE compiled description per track: the session's style, the seed-picked
  // variation, the frozen BPM/key (BPM/key never drift; variety comes
  // from the seed), and (vocal only) the language + lyric-context tail. Custom mode
  // submits it as `style`, non-custom (vocal) mode as `prompt` — either way the
  // hidden seed's variation actually reaches the provider.
  const description = styleWithTail(
    snapshot,
    `, ${variation}${frozenStyleSuffix(snapshot)}${vocalDescriptionTail(snapshot)}`,
    maxDescriptionLength,
  );
  return {
    prompt: description,
    style: description,
    title: deriveTrackMetadata(snapshot, trackIndex).title,
    seed,
    instrumental: snapshot.vocalMode === 'instrumental',
    ...(negativeTags ? { negativeTags } : {}),
  };
}
