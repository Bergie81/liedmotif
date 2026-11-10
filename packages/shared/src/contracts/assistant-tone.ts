// The tone a user gave the Assistant. Stored in the `user_settings` key/value
// table under the `assistantTone` key; this schema is the single validation
// boundary. Who may ask the Assistant, and how often, is the Admin's to set and
// lives in `assistant-access`.

import { z } from 'zod';
import { apiResponse } from './common';

/**
 * The longest tone a user can save. The tone rides on the system prompt of
 * every message, so its length is paid for each time.
 */
export const ASSISTANT_TONE_MAX_LENGTH = 600;

/**
 * - `tone`: how the Assistant should word its answers, in the user's own
 *   words. Empty means the default voice.
 */
export const assistantToneSchema = z.strictObject({
  tone: z.string().trim().max(ASSISTANT_TONE_MAX_LENGTH),
});
export type AssistantTone = z.infer<typeof assistantToneSchema>;

export const DEFAULT_ASSISTANT_TONE: AssistantTone = { tone: '' };

/** A save answers with the tone as stored. */
export const assistantToneResponseSchema = apiResponse(assistantToneSchema);
export type AssistantToneResponse = z.infer<typeof assistantToneResponseSchema>;
