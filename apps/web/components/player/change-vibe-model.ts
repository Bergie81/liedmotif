// Change Vibe overlay model: map the
// queue poll's `vibe` projection to picker preselection, and build the intent a
// submit sends. Preselected values are the CURRENT vibe; only picks the user
// actually changes ride the intent (untouched controls must not lock the
// message out of steering those facets), and a picks-only change without a
// message adjusts the current style by those picks alone.

import {
  DURATION_TARGET_REACHED_MESSAGE,
  SESSION_LANGUAGES,
  isDurationTargetReached,
  narrowTo,
  type ChangeVibeIntentInput,
  type SessionVibe,
} from '@liedmotif/shared';
import { GENRE_FAMILIES, MAX_GENRES } from '@/components/create/genre-vocabulary';
import {
  DEFAULT_GUARDRAIL_DRAFT,
  guardrailLevelFromSlider,
  guardrailSliderFromLevel,
  type EnergyLevel,
  type GuardrailDraft,
  type GuardrailPicks,
  type VocalMode,
  type VoicePreference,
} from '@/components/create/create-session-model';
import type { SessionLanguageChoice } from '@/lib/sessions/session-languages';

/** The overlay's fine-tune state. `energy: null` = the vibe has no energy
 *  facet (nothing selected); Voice `'any'` and Language `'auto'` are the
 *  create screen's omission values. The Guardrails ride in the same slider
 *  units the create screen uses, so both surfaces share one conversion. */
export interface ChangeVibePicks extends GuardrailDraft {
  genres: string[];
  energy: EnergyLevel | null;
  vocal: VocalMode;
  voice: VoicePreference;
  /** Sing with the user's own voice profile (vocal vibes only). */
  ownVoice: boolean;
  language: SessionLanguageChoice;
}

/** Spelling-insensitive genre key: lowercase, `&`→and, non-alphanumerics
 *  dropped — so an LLM's "Lo-fi" or "Drum & Bass" meets the vocabulary's
 *  `lofi` / `drum-and-bass`. */
function genreKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

const GENRE_ID_BY_KEY = new Map<string, string>(
  GENRE_FAMILIES.flatMap((family) =>
    family.genres.flatMap((genre) => [
      [genreKey(genre.id), genre.id] as const,
      [genreKey(genre.label), genre.id] as const,
    ]),
  ),
);

/** Vocabulary ids for the snapshot's genre tags, unmatched tags dropped,
 *  capped at the picker limit (lead tags are the explicit picks). */
function matchGenreTags(tags: readonly string[]): string[] {
  const matched: string[] = [];
  for (const tag of tags) {
    const id = GENRE_ID_BY_KEY.get(genreKey(tag));
    if (id && !matched.includes(id)) matched.push(id);
    if (matched.length >= MAX_GENRES) break;
  }
  return matched;
}

/** The overlay's preselection: the session's current vibe as picker state.
 *  Language shows the ACTUAL resolved language; Auto Detect appears only when
 *  none is resolved (or the resolved one is outside the selectable list). */
export function vibeToPicks(vibe: SessionVibe | null): ChangeVibePicks {
  return {
    genres: matchGenreTags(vibe?.genreTags ?? []),
    energy: vibe?.energy ?? null,
    vocal: vibe?.vocalMode ?? 'instrumental',
    voice: vibe?.voiceGender ?? 'any',
    ownVoice: vibe?.ownVoice ?? false,
    language: narrowTo(SESSION_LANGUAGES, vibe?.language) ?? 'auto',
    // A vibe from before Guardrails existed has no frozen levels; the sliders
    // then show the domain defaults, which is also what the server would stamp.
    followStyle:
      vibe?.styleStrength != null
        ? guardrailSliderFromLevel(vibe.styleStrength)
        : DEFAULT_GUARDRAIL_DRAFT.followStyle,
    surprise:
      vibe?.novelty != null
        ? guardrailSliderFromLevel(vibe.novelty)
        : DEFAULT_GUARDRAIL_DRAFT.surprise,
    // The verbatim Avoid text is the editable identity — the compiled negative
    // terms also carry system steers (like `vocals`) the user never typed.
    avoid: vibe?.avoid ?? '',
  };
}

/** Order-sensitive — the lead genre steers the compiled style. */
function genresChanged(initial: ChangeVibePicks, picks: ChangeVibePicks): boolean {
  return initial.genres.join('\n') !== picks.genres.join('\n');
}

export function hasPickChanges(initial: ChangeVibePicks, picks: ChangeVibePicks): boolean {
  return (
    genresChanged(initial, picks) ||
    initial.energy !== picks.energy ||
    initial.vocal !== picks.vocal ||
    initial.voice !== picks.voice ||
    initial.ownVoice !== picks.ownVoice ||
    initial.language !== picks.language ||
    initial.followStyle !== picks.followStyle ||
    initial.surprise !== picks.surprise ||
    initial.avoid.trim() !== picks.avoid.trim()
  );
}

/** The Guardrails as an intent carries them, changed ones only — an untouched
 *  level must stay off the intent so the server carries the running Session's
 *  value forward. A CLEARED Avoid rides as `''`: the empty string is the edit
 *  that drops the user's negative terms, while omission means "untouched". */
function changedGuardrails(initial: ChangeVibePicks, picks: ChangeVibePicks): GuardrailPicks {
  const avoid = picks.avoid.trim();
  return {
    ...(initial.followStyle !== picks.followStyle
      ? { styleStrength: guardrailLevelFromSlider(picks.followStyle) }
      : {}),
    ...(initial.surprise !== picks.surprise
      ? { novelty: guardrailLevelFromSlider(picks.surprise) }
      : {}),
    ...(initial.avoid.trim() !== avoid ? { avoid } : {}),
  };
}

type PromptPicks = Pick<
  Extract<ChangeVibeIntentInput, { mode: 'prompt' }>,
  'genres' | 'energy' | 'vocal' | 'voice' | 'ownVoice' | 'language'
> &
  GuardrailPicks;

/** Only the picks the user CHANGED ride a free-text intent — an untouched
 *  control describes the current state and must not overrule the message. A
 *  vocal/voice/own-voice edit pins the whole vocal group (each is meaningless
 *  without its mode), and own voice supersedes a gender pick. */
function changedPromptPicks(initial: ChangeVibePicks, picks: ChangeVibePicks): PromptPicks {
  const vocalTouched =
    initial.vocal !== picks.vocal ||
    initial.voice !== picks.voice ||
    initial.ownVoice !== picks.ownVoice;
  const ownVoice = picks.vocal === 'vocal' && picks.ownVoice;
  // `ownVoice: false` rides ONLY when the user actually turned it off — the
  // server carries a running own-voice session forward unless the intent
  // explicitly touches the opt-in.
  const ownVoicePick = ownVoice || initial.ownVoice !== picks.ownVoice ? { ownVoice } : {};
  return {
    ...(genresChanged(initial, picks) && picks.genres.length > 0 ? { genres: picks.genres } : {}),
    ...(initial.energy !== picks.energy && picks.energy != null ? { energy: picks.energy } : {}),
    ...(vocalTouched ? { vocal: picks.vocal, ...ownVoicePick } : {}),
    ...(vocalTouched && picks.vocal === 'vocal' && !ownVoice ? voicePick(initial, picks) : {}),
    ...(initial.language !== picks.language ? { language: picks.language } : {}),
    ...changedGuardrails(initial, picks),
  };
}

/** A concrete voice always rides a touched vocal group. Any rides as the
 *  explicit `'any'` marker only when the user moved to it — an omission would
 *  let the server keep the running voice. */
function voicePick(initial: ChangeVibePicks, picks: ChangeVibePicks): Pick<PromptPicks, 'voice'> {
  if (picks.voice !== 'any') return { voice: picks.voice };
  return initial.voice !== 'any' ? { voice: 'any' } : {};
}

/** The controls branch's language: a concrete pick always rides (WYSIWYG), and
 *  Auto Detect rides as the explicit `'auto'` marker only when the user picked
 *  it — an omission lets the server carry the running language forward, which
 *  is right for an untouched Auto Detect (the vibe may hold a language outside
 *  the selectable list) and wrong for a chosen one. */
function languagePick(
  initial: ChangeVibePicks,
  picks: ChangeVibePicks,
): { language?: SessionLanguageChoice } {
  return picks.language !== 'auto' || initial.language !== 'auto'
    ? { language: picks.language }
    : {};
}

/** A controls intent that IS the overlay state for the five facets (WYSIWYG),
 *  with the stored controls' other fields (activity, mood, …) preserved. */
function mergedControlsIntent(
  vibe: SessionVibe | null,
  initial: ChangeVibePicks,
  picks: ChangeVibePicks,
): ChangeVibeIntentInput {
  const stored = vibe?.controls ?? {};
  // The Guardrails come out with the rest of the WYSIWYG facets: the stored
  // controls are the intent that CREATED the vibe, so their levels are stale
  // the moment any later change moved a slider — the overlay state (seeded
  // from the live snapshot) is the truth here.
  const {
    genres: _g,
    energy: _e,
    vocal: _v,
    voice: _vo,
    ownVoice: _ov,
    language: _l,
    styleStrength: _ss,
    novelty: _n,
    avoid: _a,
    ...rest
  } = stored;
  const ownVoice = picks.vocal === 'vocal' && picks.ownVoice;
  const avoid = picks.avoid.trim();
  return {
    mode: 'controls',
    controls: {
      ...rest,
      styleStrength: guardrailLevelFromSlider(picks.followStyle),
      novelty: guardrailLevelFromSlider(picks.surprise),
      // Sent even when empty: on this branch an omission would let the server
      // carry the running Session's Avoid forward, so a cleared box would not
      // clear anything.
      avoid,
      ...(picks.genres.length > 0 ? { genres: picks.genres } : {}),
      ...(picks.energy != null ? { energy: picks.energy } : {}),
      vocal: picks.vocal,
      ...(ownVoice ? { ownVoice: true } : {}),
      ...(picks.vocal === 'vocal' && !ownVoice && picks.voice !== 'any'
        ? { voice: picks.voice }
        : {}),
      ...languagePick(initial, picks),
    },
  };
}

const NOTHING_TO_SUBMIT = 'Describe the change or adjust the fine-tune options.';

/**
 * Build the intent a Change Vibe submit sends.
 * - Message present → prompt intent; changed picks ride as authoritative.
 * - Picks-only over a controls vibe (a legacy controls-born Session) → the
 *   stored controls with the edits.
 * - Any other picks-only change → a picks intent with the changed picks only;
 *   the server adjusts the current Style Snapshot by them and never re-reads
 *   the prompt history as a request.
 * - Nothing changed, or only a change the picks intent cannot carry (every
 *   genre cleared) → not submittable.
 */
export function buildChangeVibeIntent(args: {
  message: string;
  vibe: SessionVibe | null;
  initial: ChangeVibePicks;
  picks: ChangeVibePicks;
}): { ok: true; intent: ChangeVibeIntentInput } | { ok: false; error: string } {
  const message = args.message.trim();
  const picksChanged = hasPickChanges(args.initial, args.picks);
  if (message) {
    return {
      ok: true,
      intent: { mode: 'prompt', prompt: message, ...changedPromptPicks(args.initial, args.picks) },
    };
  }
  if (!picksChanged) return { ok: false, error: NOTHING_TO_SUBMIT };
  if (args.vibe?.controls) {
    return { ok: true, intent: mergedControlsIntent(args.vibe, args.initial, args.picks) };
  }
  const picks = changedPromptPicks(args.initial, args.picks);
  if (Object.keys(picks).length === 0) return { ok: false, error: NOTHING_TO_SUBMIT };
  return { ok: true, intent: { mode: 'picks', ...picks } };
}

/** Duration is Session policy: only an explicit edit rides the request, never the creative intent.
 *  A creative change needs a target the music generated so far has not met —
 *  at the target a new revision could never fill, and the server
 *  refuses it the same way. */
export function buildChangeVibeRequest(
  args: Parameters<typeof buildChangeVibeIntent>[0] & {
    initialTarget: number | null;
    target: number | null;
    /** Usable generated music so far — what the duration target counts. */
    generatedDurationSeconds: number;
  },
):
  | { ok: true; input?: ChangeVibeIntentInput; targetDurationMinutes?: number | null }
  | { ok: false; error: string } {
  const durationChanged = args.initialTarget !== args.target;
  const built = buildChangeVibeIntent(args);
  if (!built.ok && durationChanged) return { ok: true, targetDurationMinutes: args.target };
  if (built.ok && isDurationTargetReached(args.target, args.generatedDurationSeconds)) {
    return { ok: false, error: DURATION_TARGET_REACHED_MESSAGE };
  }
  if (!built.ok) return built;
  return {
    ok: true,
    input: built.intent,
    ...(durationChanged ? { targetDurationMinutes: args.target } : {}),
  };
}
