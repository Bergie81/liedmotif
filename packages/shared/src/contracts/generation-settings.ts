// Owner-scoped generation settings: the Buffer fill policy and how much new
// music a new Session generates. Stored in
// the `user_settings` key/value table under the `generation` key; this schema is
// the single validation boundary (the DB repo stores only values that parsed
// here). Validated by the `/api/settings/generation` route and the api-client.

import { z } from 'zod';
import { apiResponse } from './common';
import { SESSION_LANGUAGES } from './domain';

/** Buffer-ahead bounds (whole tracks) — the settings slider's range. */
export const BUFFER_AHEAD_TRACKS_MIN = 1;
export const BUFFER_AHEAD_TRACKS_MAX = 10;

/**
 * The Default Session duration choices, in minutes. Null (No limit) is the
 * sixth choice, and only ever one the user picked.
 */
export const DEFAULT_SESSION_DURATION_CHOICES = [5, 15, 30, 60, 120] as const;
export type DefaultSessionDurationMinutes = (typeof DEFAULT_SESSION_DURATION_CHOICES)[number];

/**
 * The `generation` settings object.
 *
 * - `defaultSessionDurationMinutes`: the Session duration target a new Session
 *   takes when its start names none; null is No limit.
 * - `bufferAheadTracks`: how many Tracks a generating (`keep_going`) Session
 *   keeps ready ahead of the playhead.
 * - `defaultLanguage`: the owner default for session titles, track titles, and
 *   vocals. `'auto'` = detect from the create prompt; a concrete language seeds
 *   the create screen's Language selector.
 */
export const generationSettingsSchema = z.strictObject({
  defaultSessionDurationMinutes: z.literal(DEFAULT_SESSION_DURATION_CHOICES).nullable(),
  bufferAheadTracks: z.number().int().min(BUFFER_AHEAD_TRACKS_MIN).max(BUFFER_AHEAD_TRACKS_MAX),
  defaultLanguage: z.enum(['auto', ...SESSION_LANGUAGES]),
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  defaultSessionDurationMinutes: 30,
  bufferAheadTracks: 3,
  defaultLanguage: 'auto',
};

/** Update request: a partial patch; omitted fields keep their current value. */
export const updateGenerationSettingsRequestSchema = generationSettingsSchema.partial();
export type UpdateGenerationSettingsRequest = z.infer<typeof updateGenerationSettingsRequestSchema>;

/** Both GET and POST answer with the full effective settings (defaults merged). */
export const generationSettingsResponseSchema = apiResponse(generationSettingsSchema);
export type GenerationSettingsResponse = z.infer<typeof generationSettingsResponseSchema>;
