import {
  DEFAULT_NOVELTY,
  DEFAULT_STYLE_STRENGTH,
  ENERGY_LEVELS,
  VOCAL_MODES,
  type CoverStyleChoice,
  type SessionIntentInput,
  type StartSessionRequest,
  type SurpriseProposal,
} from '@liedmotif/shared';
import { SESSION_LANGUAGE_CHOICES, type SessionLanguageChoice } from '@/lib/session-languages';
import { MAX_GENRES } from './genre-vocabulary';

export type EnergyLevel = (typeof ENERGY_LEVELS)[number];
export type VocalMode = (typeof VOCAL_MODES)[number];

/** The Voice (gender) preference for vocal sessions. 'any' is the contract's
 * omission (no pick). */
export type VoicePreference = 'any' | 'female' | 'male';

/** The Fine-tune fold's picks as the UI holds them: 'auto'/'any' means "no pick"
 * (the request omits the field and the derivation decides). Own Voice implies
 * vocals — when on, the request pins `vocal: 'vocal'` and the gender preference
 * stays out of the question. */
export interface DescribeFineTune {
  genres: string[];
  energy: 'auto' | EnergyLevel;
  vocal: 'auto' | VocalMode;
  voice: VoicePreference;
  ownVoice: boolean;
  language: SessionLanguageChoice;
}

/** What `buildPromptIntent` accepts: any subset of the fine-tune picks, plus the
 * Guardrails fold. */
export type DescribePicks = Partial<DescribeFineTune> & {
  guardrails?: GuardrailDraft;
};

/** The Session Guardrails as the create card holds them: both levels in the
 *  sliders' own 0–100 units, and the Avoid text exactly as typed. */
export interface GuardrailDraft {
  followStyle: number;
  surprise: number;
  avoid: string;
}

/** Where the Guardrail sliders start — the shared domain defaults in slider
 *  units, so the two representations can never drift apart. */
export const DEFAULT_GUARDRAIL_DRAFT: GuardrailDraft = {
  followStyle: Math.round(DEFAULT_STYLE_STRENGTH * 100),
  surprise: Math.round(DEFAULT_NOVELTY * 100),
  avoid: '',
};

/** A stored 0–1 level back in slider units, for seeding the controls from a
 *  Session's frozen Guardrails. */
export function guardrailSliderFromLevel(level: number): number {
  return Math.min(100, Math.max(0, Math.round(level * 100)));
}

/** A slider position as the contract's 0–1 level. Rounding is what makes an
 *  untouched slider send the domain default EXACTLY (`0.65 * 100` is not 65 in
 *  binary floating point); the clamp keeps a stray value from failing the whole
 *  submit on contract validation. */
export function guardrailLevelFromSlider(sliderValue: number): number {
  return Math.min(100, Math.max(0, Math.round(sliderValue))) / 100;
}

/** The Guardrails as an intent carries them: 0–1 levels and the Avoid text,
 *  each present only when this intent means to set it. */
export interface GuardrailPicks {
  styleStrength?: number;
  novelty?: number;
  avoid?: string;
}

/**
 * The Guardrail picks an intent carries. Both levels ALWAYS ride a new Session:
 * they are frozen into its Style Snapshot, so what the sliders showed at Start
 * is what every Track of that vibe — including a much later Dislike reroll —
 * generates under. The Avoid text rides only when the user wrote something.
 */
function guardrailPicks(draft: GuardrailDraft | undefined): GuardrailPicks {
  if (!draft) return {};
  const avoid = draft.avoid.trim();
  return {
    styleStrength: guardrailLevelFromSlider(draft.followStyle),
    novelty: guardrailLevelFromSlider(draft.surprise),
    ...(avoid ? { avoid } : {}),
  };
}

/** The Voice pick a request may carry: vocal sessions only, and Any is omission. */
function voicePick(
  vocal: VocalMode | undefined,
  voice: VoicePreference | undefined,
): { voice?: Exclude<VoicePreference, 'any'> } {
  return vocal === 'vocal' && voice && voice !== 'any' ? { voice } : {};
}

/** The Language pick a request may carry: NOT vocal-gated (it also steers title
 * language for instrumental sessions), and Auto Detect is omission. */
function languagePick(language: SessionLanguageChoice | undefined): {
  language?: Exclude<SessionLanguageChoice, 'auto'>;
} {
  return language && language !== 'auto' ? { language } : {};
}

export function buildPromptIntent(
  prompt: string,
  picks: DescribePicks = {},
): { ok: true; intent: SessionIntentInput } | { ok: false; error: string } {
  const normalized = prompt.trim();
  if (!normalized) return { ok: false, error: 'Describe a vibe first.' };
  const genres = (picks.genres ?? []).map((genre) => genre.trim()).filter(Boolean);
  const energy = picks.energy && picks.energy !== 'auto' ? picks.energy : undefined;
  // Own Voice implies vocals: the pick pins the mode and supersedes a gender
  // preference (the user's own voice defines the singer).
  const ownVoice = picks.ownVoice === true;
  const explicitVocal = picks.vocal && picks.vocal !== 'auto' ? picks.vocal : undefined;
  const vocal = ownVoice ? 'vocal' : explicitVocal;
  return {
    ok: true,
    intent: {
      mode: 'prompt',
      prompt: normalized,
      ...(genres.length > 0 ? { genres } : {}),
      ...(energy ? { energy } : {}),
      ...(vocal ? { vocal } : {}),
      ...(ownVoice ? { ownVoice: true } : {}),
      ...voicePick(vocal, ownVoice ? 'any' : picks.voice),
      ...languagePick(picks.language),
      ...guardrailPicks(picks.guardrails),
    },
  };
}

/** The fine-tune picks a Surprise Me proposal asks for, as the form holds them. */
export function surpriseFineTune(
  edit: SurpriseProposal['edit'],
  defaultLanguage: SessionLanguageChoice,
): DescribeFineTune {
  return {
    genres: edit.genres.slice(0, MAX_GENRES),
    energy: edit.energy ?? 'auto',
    vocal: edit.vocal ?? 'auto',
    voice: 'any',
    ownVoice: false,
    language:
      SESSION_LANGUAGE_CHOICES.find((choice) => choice === edit.language) ?? defaultLanguage,
  };
}

/**
 * Whether the form still asks for exactly what the proposal does. Only then
 * may a start use the proposal's stored Style Snapshot; any edit — a word, a
 * pick, a Guardrail — makes it the User's own request.
 */
export function formMatchesSurprise(
  prompt: string,
  picks: DescribePicks,
  edit: SurpriseProposal['edit'],
  defaultLanguage: SessionLanguageChoice,
): boolean {
  const form = buildPromptIntent(prompt, picks);
  const proposed = buildPromptIntent(edit.prompt, {
    ...surpriseFineTune(edit, defaultLanguage),
    guardrails: DEFAULT_GUARDRAIL_DRAFT,
  });
  return form.ok && proposed.ok && JSON.stringify(form.intent) === JSON.stringify(proposed.intent);
}

/** The Session-wide extras that ride the request envelope beside the intent. */
export interface StartRequestExtras {
  coverStyle: CoverStyleChoice;
  /** Start this Session without the listener profile (the home-page toggle). */
  skipProfile: boolean;
  /**
   * The cover-source toggle's shown state. Always sent explicitly — its
   * default comes from a SETTING, so omission could silently diverge from
   * what the toggle displayed.
   */
  useStandardCover: boolean;
}

/** Assemble the Start Session request envelope: static defaults stay OFF the
 * wire, so omission (not a sentinel value) means "server default". */
export function buildStartRequest(
  input: SessionIntentInput,
  clientId: string,
  extras: StartRequestExtras,
): StartSessionRequest {
  return {
    input,
    clientId,
    ...(extras.coverStyle !== 'auto' ? { coverStyle: extras.coverStyle } : {}),
    ...(extras.skipProfile ? { skipProfile: true } : {}),
    useStandardCover: extras.useStandardCover,
  };
}
