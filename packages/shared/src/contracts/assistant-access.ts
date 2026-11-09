// Who may ask the Assistant, and how often. The Admin sets an instance default
// (`app_settings` under `assistant`) and may give a Member values of their own
// (`user_settings` under `assistant`). The unit is messages per day, the day
// being the one in the Instance timezone. The Admin has no daily allowance: the
// text LLM runs on their own key.

import { z } from 'zod';
import { isoDatetimeSchema } from './common';

/**
 * The range a daily allowance may take. At least one message, because "none"
 * is what the access switch says; the upper end is a typo guard far above what
 * anyone asks in a day.
 */
export const ASSISTANT_DAILY_MESSAGES_MIN = 1;
export const ASSISTANT_DAILY_MESSAGES_MAX = 1000;

const dailyMessagesSchema = z
  .number()
  .int()
  .min(ASSISTANT_DAILY_MESSAGES_MIN)
  .max(ASSISTANT_DAILY_MESSAGES_MAX);

/** Access to the Assistant: whether a Member has it, and their messages per day. */
export const assistantAccessSchema = z.strictObject({
  enabled: z.boolean(),
  dailyMessages: dailyMessagesSchema,
});
export type AssistantAccess = z.infer<typeof assistantAccessSchema>;

/** What every Member gets until the Admin says otherwise. */
export const DEFAULT_ASSISTANT_ACCESS: AssistantAccess = { enabled: true, dailyMessages: 30 };

/** A change to the instance default: any subset of its fields. */
export const updateAssistantAccessRequestSchema = assistantAccessSchema.partial();
export type UpdateAssistantAccessRequest = z.infer<typeof updateAssistantAccessRequestSchema>;

/**
 * One Member's own values. A field that is absent follows the instance default,
 * so a change to the default reaches every Member who has not been given a
 * value of their own for that field.
 */
export const memberAssistantAccessSchema = assistantAccessSchema.partial();
export type MemberAssistantAccess = z.infer<typeof memberAssistantAccessSchema>;

/**
 * A change to one Member's own values. `null` takes a field back to the
 * instance default; a field left out stays as it is.
 */
export const updateMemberAssistantAccessRequestSchema = z
  .strictObject({
    enabled: z.boolean().nullable(),
    dailyMessages: dailyMessagesSchema.nullable(),
  })
  .partial();
export type UpdateMemberAssistantAccessRequest = z.infer<
  typeof updateMemberAssistantAccessRequestSchema
>;

/** The access a Member really has: their own values over the instance default. */
export function effectiveAssistantAccess(
  instanceDefault: AssistantAccess,
  own: MemberAssistantAccess,
): AssistantAccess {
  return {
    enabled: own.enabled ?? instanceDefault.enabled,
    dailyMessages: own.dailyMessages ?? instanceDefault.dailyMessages,
  };
}

/**
 * Where one user stands with the Assistant right now. `allowance` is `null`
 * for a user with no daily allowance (the Admin).
 */
export const assistantStandingSchema = z.strictObject({
  /** Whether the user has the Assistant at all. */
  enabled: z.boolean(),
  allowance: z
    .strictObject({
      dailyMessages: z.number().int().nonnegative(),
      /** Messages still open today; never below zero. */
      remaining: z.number().int().nonnegative(),
      /** The instant the next day starts in the Instance timezone. */
      resetsAt: isoDatetimeSchema,
    })
    .nullable(),
});
export type AssistantStanding = z.infer<typeof assistantStandingSchema>;

/**
 * The response header `POST /api/assistant` reports the standing in, as JSON,
 * on an answer and on a refusal alike. The panel reads it instead of asking.
 */
export const ASSISTANT_STANDING_HEADER = 'Assistant-Standing';
