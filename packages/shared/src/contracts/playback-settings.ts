// Owner-scoped playback settings. Stored in the
// `user_settings` key/value table under the `playback` key; this schema is the
// single validation boundary (the DB repo stores only values that parsed here).
//
// Like `getTrack`, this is a standalone contract — not one of the 16 registry
// endpoints — validated by the `/api/settings/playback` route and the api-client.

import { z } from 'zod';
import { apiResponse } from './common';

/** Crossfade bounds (seconds) — the settings slider's range (2–12 s). */
export const CROSSFADE_SECONDS_MIN = 2;
export const CROSSFADE_SECONDS_MAX = 12;

/** The `playback` settings object: blend on/off + crossfade length. */
export const playbackSettingsSchema = z.strictObject({
  blendEnabled: z.boolean(),
  crossfadeSeconds: z.number().min(CROSSFADE_SECONDS_MIN).max(CROSSFADE_SECONDS_MAX),
});
export type PlaybackSettings = z.infer<typeof playbackSettingsSchema>;

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  blendEnabled: true,
  crossfadeSeconds: 6,
};

/** Update request: a partial patch; omitted fields keep their current value. */
export const updatePlaybackSettingsRequestSchema = playbackSettingsSchema.partial();
export type UpdatePlaybackSettingsRequest = z.infer<typeof updatePlaybackSettingsRequestSchema>;

/** Both GET and POST answer with the full effective settings (defaults merged). */
export const playbackSettingsResponseSchema = apiResponse(playbackSettingsSchema);
export type PlaybackSettingsResponse = z.infer<typeof playbackSettingsResponseSchema>;
