// Surprise Me: a previewed vibe proposal. Everything here is the
// public preview — the proposal's Style Snapshot, lyric direction and any
// About-derived notes never leave the server.

import { z } from 'zod';
import { apiResponse, uuidSchema } from './common';
import { startSessionRequestSchema, targetDurationMinutesSchema } from './endpoints';
import { ENERGY_LEVELS, SESSION_LANGUAGES, VOCAL_MODES, VOICE_GENDERS } from './domain';

/** The kind of situation a proposal is set in; `any` lets the plan choose. */
export const SURPRISE_THEMES = [
  'any',
  'morning',
  'focus',
  'movement',
  'travel',
  'home',
  'friends',
  'rest',
  'mood',
  'place',
  'about-me',
] as const;
export type SurpriseTheme = (typeof SURPRISE_THEMES)[number];

/** A theme whose proposals are always sung, whatever the vocals choice. */
export function isSungTheme(theme: SurpriseTheme): boolean {
  return theme === 'about-me';
}

/** Vocals for a proposal: `taste` follows learned taste (instrumental without it). */
export const SURPRISE_VOCALS = ['taste', 'instrumental', 'vocal'] as const;
export type SurpriseVocal = (typeof SURPRISE_VOCALS)[number];

export const surpriseProposalSchema = z.strictObject({
  /** The identity Try another, Dismiss and Start must name; a replaced one is dead. */
  id: uuidSchema,
  adventurous: z.boolean(),
  title: z.string(),
  mood: z.string(),
  genres: z.array(z.string()),
  energy: z.enum(ENERGY_LEVELS),
  vocalMode: z.enum(VOCAL_MODES),
  voiceGender: z.enum(VOICE_GENDERS).nullable(),
  language: z.string().nullable(),
  /** Made under Start without profile: a start under the other setting is the User's own request. */
  skipProfile: z.boolean(),
  /**
   * What Edit hands to the normal creation form: the request text and the
   * fine-tune picks the proposal was made from. A situation plus musical
   * direction; the owner's own city is the only profile detail it may carry —
   * never People or About content.
   */
  edit: z.strictObject({
    prompt: z.string(),
    genres: z.array(z.string()),
    energy: z.enum(ENERGY_LEVELS).nullable(),
    vocal: z.enum(VOCAL_MODES).nullable(),
    language: z.string().nullable(),
    /** The Session duration target the card prefills. */
    durationMinutes: targetDurationMinutesSchema.nullable(),
  }),
});
export type SurpriseProposal = z.infer<typeof surpriseProposalSchema>;

export const proposeSurpriseRequestSchema = z.strictObject({
  /** More adventurous; omitted = Familiar. */
  adventurous: z.boolean().optional(),
  /** Start without profile: no profile or People context is read. */
  skipProfile: z.boolean().optional(),
  /** Omitted = `any`. */
  theme: z.enum(SURPRISE_THEMES).optional(),
  /** Omitted = `taste`. */
  vocal: z.enum(SURPRISE_VOCALS).optional(),
  /** The Session language (name, titles, lyrics); omitted = Auto, drawn from learned taste. */
  language: z.enum(SESSION_LANGUAGES).optional(),
  /** The pending proposal this tab is showing (Try another), or null for none. */
  replaces: uuidSchema.nullable(),
});
export type ProposeSurpriseRequest = z.infer<typeof proposeSurpriseRequestSchema>;

export const proposeSurpriseResponseSchema = apiResponse(
  z.strictObject({ proposal: surpriseProposalSchema }),
);

export const pendingSurpriseResponseSchema = apiResponse(
  z.strictObject({ proposal: surpriseProposalSchema.nullable() }),
);

export const dismissSurpriseRequestSchema = z.strictObject({ proposalId: uuidSchema });
export const dismissSurpriseResponseSchema = apiResponse(
  z.strictObject({ dismissed: z.literal(true) }),
);

/**
 * Start the previewed proposal as a Session. Only its identity and the card's
 * non-musical choices travel: the Style Snapshot is the server's stored one.
 * Answers with `startSessionResponseSchema`.
 */
export const startSurpriseRequestSchema = startSessionRequestSchema
  .pick({ targetDurationMinutes: true, coverStyle: true, useStandardCover: true })
  .extend({ proposalId: uuidSchema });
export type StartSurpriseRequest = z.infer<typeof startSurpriseRequestSchema>;
