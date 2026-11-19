// The first-login flow: one decision per screen, seven steps in three groups.
//
// Each step persists its own decision through the same API its Settings page uses, so
// nothing here is a second way to write the same data — and a step left half-finished
// has still written whatever it saved. The wizard therefore holds only which step is
// showing plus the draft the rail reads back and a revisited step re-renders from.

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { OnboardingData } from '@/lib/onboarding/onboarding-data';
import { readCoverKeyState } from '@/lib/settings/settings-client';
import { OnboardingCoversStep } from './onboarding-covers-step';
import { OnboardingDoneStep } from './onboarding-done-step';
import {
  OnboardingBackLink,
  OnboardingRail,
  OnboardingShell,
  OnboardingStrip,
} from './onboarding-layout';
import { OnboardingLlmStep } from './onboarding-llm-step';
import { OnboardingMusicStep } from './onboarding-music-step';
import {
  ONBOARDING_STEPS,
  initialOnboardingDraft,
  musicProviderCoversReady,
  onboardingRecord,
  resolveInitialTimezone,
  type OnboardingDraft,
  type OnboardingStepId,
} from './onboarding-model';
import { OnboardingPeopleStep } from './onboarding-people-step';
import { OnboardingProfileStep } from './onboarding-profile-step';
import { OnboardingTracksStep } from './onboarding-tracks-step';
import { refreshRosterNames, useOnboardingNav } from './use-onboarding-nav';

export function OnboardingWizard({
  data,
  avatarUrl,
}: {
  data: OnboardingData;
  avatarUrl: string | null;
}) {
  const { index, furthest, go, advance, step, previous } = useOnboardingNav(ONBOARDING_STEPS);
  const [draft, setDraft] = useState<OnboardingDraft>(() => initialOnboardingDraft(data));
  // Uploaded on the profile screen and shown again on the People screen. Held here
  // rather than read back from the session, because the upload route's own
  // `router.refresh()` is a round trip the next step must not wait for.
  const [avatar, setAvatar] = useState(avatarUrl);

  const patch = useCallback((change: Partial<OnboardingDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
  }, []);

  // Only the browser knows where the owner is, and this component server-renders
  // first: suggesting the zone during render would paint the HOST's zone and then
  // swap it under the owner at hydration. The draft therefore starts on the stored
  // zone and the suggestion lands once, after mount, before anyone can have touched
  // the control.
  useEffect(() => {
    setDraft((current) => ({ ...current, timezone: resolveInitialTimezone(current.timezone) }));
  }, []);
  // Stable, because the People form mirrors its roster out from an effect keyed on
  // this callback: a fresh closure each render would re-fire that effect on its own
  // result.
  const setRoster = useCallback((people: OnboardingDraft['people']) => patch({ people }), [patch]);

  async function advanceFromProfile() {
    await refreshRosterNames((update) =>
      setDraft((current) => ({ ...current, people: update(current.people) })),
    );
    advance();
  }

  /**
   * The Text AI just saved decides whether Covers can use its key, and whether a
   * Cover key that shares it still resolves; only the server knows (vendor,
   * endpoint, readable secret). Best-effort: a failed read keeps what is known.
   */
  async function advanceFromLlm() {
    const state = await readCoverKeyState();
    if (state)
      patch({ sharedKeyVendor: state.sharedKeyVendor, imageConnected: state.coverConnected });
    advance();
  }

  function renderStep(id: OnboardingStepId) {
    switch (id) {
      case 'you':
        return (
          <OnboardingProfileStep
            profile={draft.profile}
            avatarUrl={avatar}
            timezone={{ value: draft.timezone, onChange: (timezone) => patch({ timezone }) }}
            onChange={(profile) => patch({ profile })}
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
      case 'music':
        return (
          <OnboardingMusicStep
            credential={{ ...data.music, configured: draft.musicConnected }}
            encryptionKeyConfigured={data.encryptionKeyConfigured}
            onConnected={() => patch({ musicConnected: true })}
            onDone={advance}
          />
        );
      case 'tracks':
        return (
          <OnboardingTracksStep
            ceiling={draft.ceiling}
            tracksPerRequest={data.tracksPerRequest}
            minHeadroomTracks={data.limits.minHeadroomTracksToStartSession}
            onChange={(ceiling) => patch({ ceiling })}
            onDone={() => {
              patch({ savedCeiling: draft.ceiling });
              advance();
            }}
          />
        );
      case 'llm':
        return (
          <OnboardingLlmStep
            credential={{ ...data.llm, configured: draft.llmConnected }}
            encryptionKeyConfigured={data.encryptionKeyConfigured}
            onConnected={(llmModel) => patch({ llmConnected: true, llmModel })}
            onDone={advanceFromLlm}
          />
        );
      case 'covers':
        return (
          <OnboardingCoversStep
            budget={draft.coverBudget}
            credential={data.image}
            imageProviderKey={draft.imageProviderKey}
            sharedKeyVendor={draft.sharedKeyVendor}
            imageConnected={draft.imageConnected}
            imageModel={draft.imageModel}
            imageOwnKey={draft.imageOwnKey}
            encryptionKeyConfigured={data.encryptionKeyConfigured}
            musicProviderCoverConfigured={musicProviderCoversReady(draft, data)}
            onChange={(coverBudget) => patch({ coverBudget })}
            onConnected={({ providerKey, model, ownKey }) =>
              patch({
                imageConnected: true,
                imageModel: model,
                imageProviderKey: providerKey,
                imageOwnKey: ownKey,
              })
            }
            onDone={() => {
              patch({ savedCoverBudget: draft.coverBudget });
              advance();
            }}
          />
        );
      case 'done':
        return <OnboardingDoneStep untouched={data.untouched} />;
    }
  }

  return (
    <OnboardingShell
      rail={
        <OnboardingRail
          currentIndex={index}
          furthestIndex={furthest}
          record={onboardingRecord(draft, data)}
          onSelect={go}
        />
      }
    >
      <OnboardingStrip currentIndex={index} />
      {previous ? (
        <OnboardingBackLink label={previous.title} onClick={() => go(index - 1)} />
      ) : null}
      {renderStep(step.id)}
    </OnboardingShell>
  );
}
