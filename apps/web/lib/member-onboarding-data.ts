// Everything a Member's welcome reads, resolved server-side. Deliberately a
// separate, narrower loader than `loadOnboardingData` (same move as the
// Settings hub): no instance limits, no provider credential status —
// none of it can reach a Member's welcome by construction. The budget figures
// come from the same loader the My budget page uses, so the welcome can never
// greet a Member with a number enforcement would disagree with.

import { EMPTY_LISTENER_PROFILE, ensureOwnerPerson, getListenerProfile } from '@liedmotif/db';
import type { ListenerProfile } from '@liedmotif/db';
import { getDb } from '@/lib/db';
import { loadMyBudgetData, type MyBudgetPageData } from '@/lib/my-budget-data';
import { loadPeopleFormProps } from '@/lib/onboarding-data';
import type { PeopleFormProps } from '@/components/settings/people-types';

export interface MemberOnboardingData {
  profile: ListenerProfile;
  people: PeopleFormProps;
  budget: MyBudgetPageData;
}

/** `null` when the user is not a Member — the caller falls back to the Admin flow. */
export async function loadMemberOnboardingData(
  ownerUserId: string,
): Promise<MemberOnboardingData | null> {
  const db = getDb();
  await ensureOwnerPerson(db, ownerUserId);
  const [profile, people, budget] = await Promise.all([
    getListenerProfile(db, ownerUserId),
    loadPeopleFormProps(ownerUserId),
    loadMyBudgetData(ownerUserId),
  ]);
  if (!budget) return null;
  return { profile: profile ?? EMPTY_LISTENER_PROFILE, people, budget };
}
