// Owner-scoped first-login onboarding state, stored in the `user_settings`
// key/value table under the `onboarding` key. This schema is where that stored
// shape is declared once, so the DB repo, the completion route, and the app guards
// cannot drift on it.

import { z } from 'zod';

/**
 * The `onboarding` settings object.
 *
 * - `completedAt`: when the owner finished (or skipped through) the first-login
 *   flow, as an ISO timestamp. `null` means it has never been completed, which is
 *   what routes the owner to `/welcome`.
 */
export const onboardingStateSchema = z.strictObject({
  completedAt: z.string().nullable(),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const DEFAULT_ONBOARDING_STATE: OnboardingState = { completedAt: null };

/** Whether the owner has been through first-login onboarding. */
export function isOnboardingComplete(state: OnboardingState): boolean {
  return state.completedAt !== null;
}
