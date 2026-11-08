// Compile a vendor-neutral `MusicGenerationInput` from a session's frozen Style
// Snapshot. This is the seam between the LLM/template producer
// and the music-provider interface: the music adapter (mock or Suno)
// never sees a Style Snapshot, only this normalized input.
//
// The session-frozen BPM and key ride INSIDE the compiled style — the provider
// interface has no explicit BPM field, and a single frozen BPM/key per session is
// what makes consecutive tracks beat-match and blend for free. The
// per-track hidden seed flows solely from the snapshot's frozen `seedParameters`
// (one seed source) and picks a small variation folded into the compiled
// prompt/style, so sibling requests genuinely differ at the provider while the
// frozen BPM/key never drifts.

import {
  budgetDescription,
  buildTrackPrompt,
  frozenBpmKeyTag,
  type SessionStyleSnapshot,
} from '../llm/index';
import type { MusicGenerationInput } from './index';

export interface CompileMusicInputOptions {
  /** Provider model option; unset means the adapter's configured default model. */
  model?: string;
  /** Provider cap for the custom-mode `style` field (capability `maxStyleLength`). */
  maxStyleLength?: number;
  /** Provider cap for the non-custom `prompt` field (capability `maxPromptLength`). */
  maxPromptLength?: number;
  /**
   * `style` cap for an own-voice submit (capability `customVoice.maxStyleLength`):
   * the adapter pins its persona model there, whose cap can differ from the
   * default model's. Unset falls back to `maxStyleLength`.
   */
  maxOwnVoiceStyleLength?: number;
}

/**
 * Build the music-provider input for the `trackIndex`-th track of a session.
 * Real sessions use custom mode (instrumental custom-mode requires `style` and
 * `title`, both produced deterministically from the snapshot).
 */
export function compileMusicGenerationInput(
  snapshot: SessionStyleSnapshot,
  trackIndex: number,
  options: CompileMusicInputOptions = {},
): MusicGenerationInput {
  // Budget the compiled description to the provider field that will carry it, so
  // the informative tail (variation, BPM/key) survives the adapter's boundary
  // clamp: instrumental sessions submit it as the custom-mode `style`, vocal
  // sessions as the non-custom `prompt` (custom-mode prompt would be lyrics) —
  // EXCEPT user-voice vocal sessions, which submit custom-mode (the persona
  // field requires it) and so carry the description as `style` again.
  const descriptionRidesPrompt = snapshot.vocalMode === 'vocal' && !snapshot.useOwnVoice;
  const maxStyleLength = snapshot.useOwnVoice
    ? (options.maxOwnVoiceStyleLength ?? options.maxStyleLength)
    : options.maxStyleLength;
  const maxDescriptionLength =
    (descriptionRidesPrompt ? options.maxPromptLength : maxStyleLength) ?? Number.POSITIVE_INFINITY;
  const params = buildTrackPrompt(snapshot, trackIndex, maxDescriptionLength);
  return {
    mode: 'custom',
    prompt: params.prompt,
    // `style`/`prompt` carry the frozen BPM/key + the seed-picked per-track
    // variation (buildTrackPrompt).
    style: params.style,
    title: params.title,
    instrumental: params.instrumental,
    seed: params.seed,
    ...(params.negativeTags ? { negativeTags: params.negativeTags } : {}),
    // The Session Guardrails ride only when the snapshot froze them: a
    // pre-guardrails snapshot must compile WITHOUT them (no default injected
    // here), so an old vibe's Dislike reroll still sounds like its siblings.
    // Every new snapshot carries values — the producers stamp them at creation.
    ...(snapshot.styleStrength !== undefined ? { styleStrength: snapshot.styleStrength } : {}),
    ...(snapshot.novelty !== undefined ? { novelty: snapshot.novelty } : {}),
    ...(options.model ? { model: options.model } : {}),
    // The literal-lyrics path (user-voice custom mode) needs the language and
    // lyric direction as FIELDS — inside the compiled English description they
    // would not survive the provider's lyrics-brief cap.
    ...(snapshot.language ? { language: snapshot.language } : {}),
    ...(snapshot.lyricContext ? { lyricBrief: snapshot.lyricContext } : {}),
  };
}

/** What a LEGACY Dislike reroll copies from the disliked track's request. */
export interface RerollSubmitContext {
  /** The ORIGINAL request's stored session style (base + frozen BPM/key tail),
   *  or the disliked track's stored prompt identity when none was persisted. */
  stylePrompt: string;
  /** The original request's persisted frozen targets (rebuild the style tail). */
  targetBpm: number | null;
  targetKey: string | null;
  vocalMode: 'instrumental' | 'vocal';
  /** The disliked track's cosmetic title; a deterministic fallback fills a null or blank one. */
  title: string | null;
  /** The original request's persisted negative tags, if any. */
  negativePrompt?: string | null;
}

/** Provider-facing title when the disliked track never got one (custom
 *  instrumental mode REQUIRES a title; display titles come from materialization). */
const REROLL_FALLBACK_TITLE = 'Untitled Session';

/**
 * The LEGACY fresh-call reroll input, for disliked tracks whose request predates
 * the persisted compilation snapshot (the canonical path re-runs
 * `compileMusicGenerationInput` over `generation_requests.style_snapshot` with a
 * fresh index — same compiler, rotated seed variation). This fallback rebuilds
 * what it can from the request's PERSISTED identity — never the live snapshot
 * (a reroll regenerates the SAME prompt; a post-Change-Vibe reroll
 * must keep the old vibe): the stored style re-budgeted against the current
 * caps with the frozen BPM/key tail (from the persisted targets) kept intact,
 * the title custom mode requires, and the stored negative tags (defaulting to
 * the template's instrumental `vocals`). The old snapshot's seed/vocal context
 * is unrecoverable here; provider randomness differentiates the take.
 */
export function compileRerollInput(
  context: RerollSubmitContext,
  options: CompileMusicInputOptions = {},
): MusicGenerationInput {
  const maxDescriptionLength =
    (context.vocalMode === 'vocal' ? options.maxPromptLength : options.maxStyleLength) ??
    Number.POSITIVE_INFINITY;
  const tail = frozenBpmKeyTag(context.targetBpm, context.targetKey);
  const base = context.stylePrompt.endsWith(tail)
    ? context.stylePrompt.slice(0, context.stylePrompt.length - tail.length)
    : context.stylePrompt;
  const description = budgetDescription(base, tail, maxDescriptionLength);
  const instrumental = context.vocalMode === 'instrumental';
  const negativeTags = context.negativePrompt ?? (instrumental ? 'vocals' : undefined);
  return {
    mode: 'custom',
    prompt: description,
    style: description,
    title: context.title?.trim() || REROLL_FALLBACK_TITLE,
    instrumental,
    ...(negativeTags ? { negativeTags } : {}),
    ...(options.model ? { model: options.model } : {}),
  };
}
