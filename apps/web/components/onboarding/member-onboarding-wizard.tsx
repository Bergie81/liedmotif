// The Member's first-login flow: You → People → the budget close. Built from
// its own step table (`MEMBER_ONBOARDING_STEPS`), so no credential, ceiling, or
// instance screen exists here to be reached — by URL or by index.

'use client';

import { useCallback, useState } from 'react';
import type { MemberOnboardingData } from '@/lib/onboarding/member-onboarding-data';
import {
  OnboardingBackLink,
  OnboardingRail,
  OnboardingShell,
  OnboardingStrip,
} from './onboarding-layout';
import {
  MEMBER_ONBOARDING_GROUPS,
  MEMBER_ONBOARDING_STEPS,
  memberOnboardingRecord,
  type MemberOnboardingDraft,
  type OnboardingStepId,
} from './onboarding-model';
import { MemberOnboardingDoneStep } from './member-onboarding-done-step';
import { OnboardingPeopleStep } from './onboarding-people-step';
import { OnboardingProfileStep } from './onboarding-profile-step';
import { refreshRosterNames, useOnboardingNav } from './use-onboarding-nav';

export function MemberOnboardingWizard({
  data,
  avatarUrl,
}: {
  data: MemberOnboardingData;
  avatarUrl: string | null;
}) {
  const { index, furthest, go, advance, step, previous } =
    useOnboardingNav(MEMBER_ONBOARDING_STEPS);
  const [draft, setDraft] = useState<MemberOnboardingDraft>(() => ({
    profile: data.profile,
    people: data.people.initialPeople,
  }));
  const [avatar, setAvatar] = useState(avatarUrl);

  const setRoster = useCallback(
    (people: MemberOnboardingDraft['people']) => setDraft((current) => ({ ...current, people })),
    [],
  );

  async function advanceFromProfile() {
    await refreshRosterNames((update) =>
      setDraft((current) => ({ ...current, people: update(current.people) })),
    );
    advance();
  }

  function renderStep(id: OnboardingStepId) {
    switch (id) {
      case 'you':
        return (
          <OnboardingProfileStep
            profile={draft.profile}
            avatarUrl={avatar}
            withDescription
            onChange={(profile) => setDraft((current) => ({ ...current, profile }))}
            onAvatarChange={setAvatar}
            onSaved={advanceFromProfile}
          />
        );
      case 'people':
        return (
          <OnboardingPeopleStep
            people={data.people}
            roster={draft.people}
            ownerImageUrl={avatar}
            onRosterChange={setRoster}
            onDone={advance}
          />
        );
      default:
        return <MemberOnboardingDoneStep budget={data.budget} />;
    }
  }

  return (
    <OnboardingShell
      rail={
        <OnboardingRail
          currentIndex={index}
          furthestIndex={furthest}
          record={memberOnboardingRecord(draft, data.budget.yours)}
          onSelect={go}
          groups={MEMBER_ONBOARDING_GROUPS}
          steps={MEMBER_ONBOARDING_STEPS}
        />
      }
    >
      <OnboardingStrip currentIndex={index} steps={MEMBER_ONBOARDING_STEPS} />
      {previous ? (
        <OnboardingBackLink label={previous.title} onClick={() => go(index - 1)} />
      ) : null}
      {renderStep(step.id)}
    </OnboardingShell>
  );
}
