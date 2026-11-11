// Process-level memo for COMPLETED first-login onboarding. `completedAt` is
// monotonic — no app path reverts it; only the dev script's `clear` deletes the
// row, and a running web process keeps answering from this memo until it
// restarts — so a completed user's guard check needs no `user_settings` round
// trip on every RSC render, queue poll, audio range request, and cover request.
// Only `true` is memoized; an incomplete (or unknown) state always re-reads,
// request-scoped.

import { cache } from 'react';
import { getOnboardingState, type Database } from '@liedmotif/db';
import { isOnboardingComplete } from '@liedmotif/shared';

const completedUserIds = new Set<string>();

const cachedOnboardingState = cache(async (db: Database, userId: string) =>
  getOnboardingState(db, userId),
);

/** Whether the user finished first-login onboarding (memoized once true). */
export async function hasCompletedOnboarding(db: Database, userId: string): Promise<boolean> {
  if (completedUserIds.has(userId)) return true;
  const complete = isOnboardingComplete(await cachedOnboardingState(db, userId));
  if (complete) completedUserIds.add(userId);
  return complete;
}

/** The completion route primes the memo the moment its write commits. */
export function markOnboardingComplete(userId: string): void {
  completedUserIds.add(userId);
}

/** Test-only: clear the process-level memo between cases. */
export function resetOnboardingMemoForTests(): void {
  completedUserIds.clear();
}
