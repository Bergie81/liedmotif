// Owner-scoped generation settings: the Buffer fill policy. Stored in
// the `user_settings` key/value table under the `generation` key; this schema is
// the single validation boundary (the DB repo stores only values that parsed
// here). Validated by the `/api/settings/generation` route and the api-client.

import { z } from 'zod';
import { apiResponse } from './common';
import { SESSION_LANGUAGES } from './domain';
import type { SessionMode } from '../state-machines/literals';

/** Buffer-ahead bounds (whole tracks) — the settings slider's range. */
export const BUFFER_AHEAD_TRACKS_MIN = 1;
export const BUFFER_AHEAD_TRACKS_MAX = 10;

/**
 * The `generation` settings object.
 *
 * - `bufferEnabled`: the owner DEFAULT for new Sessions — on starts them in
 *   `keep_going` Session mode, off in `repeat` (see `defaultSessionMode`). It
 *   never blocks a running Session: the per-session mode alone decides whether
 *   automatic top-ups run.
 * - `bufferAheadTracks`: how many Tracks a generating (`keep_going`) Session
 *   keeps ready ahead of the playhead.
 * - `defaultLanguage`: the owner default for session titles, track titles, and
 *   vocals. `'auto'` = detect from the create prompt; a concrete language seeds
 *   the create screen's Language selector.
 */
export const generationSettingsSchema = z.strictObject({
  bufferEnabled: z.boolean(),
  bufferAheadTracks: z.number().int().min(BUFFER_AHEAD_TRACKS_MIN).max(BUFFER_AHEAD_TRACKS_MAX),
  defaultLanguage: z.enum(['auto', ...SESSION_LANGUAGES]),
});
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  bufferEnabled: true,
  bufferAheadTracks: 3,
  defaultLanguage: 'auto',
};

/** The Buffer facts anything reasoning about fill policy needs. */
export type BufferPolicy = Pick<GenerationSettings, 'bufferEnabled' | 'bufferAheadTracks'>;

/**
 * The Session mode a NEW Session starts in. `bufferEnabled` is a default, never
 * a blocker: it picks the starting mode here, and the per-session mode alone
 * decides whether automatic top-ups run afterwards — switching a Session to
 * `keep_going` generates new Tracks even while the owner default is off.
 * Session creation applies this, and the settings copy describes it, so the
 * promise the UI makes and the rule creation applies cannot drift.
 */
export function defaultSessionMode(policy: Pick<GenerationSettings, 'bufferEnabled'>): SessionMode {
  return policy.bufferEnabled ? 'keep_going' : 'repeat';
}

/** Update request: a partial patch; omitted fields keep their current value. */
export const updateGenerationSettingsRequestSchema = generationSettingsSchema.partial();
export type UpdateGenerationSettingsRequest = z.infer<typeof updateGenerationSettingsRequestSchema>;

/** Both GET and POST answer with the full effective settings (defaults merged). */
export const generationSettingsResponseSchema = apiResponse(generationSettingsSchema);
export type GenerationSettingsResponse = z.infer<typeof generationSettingsResponseSchema>;
