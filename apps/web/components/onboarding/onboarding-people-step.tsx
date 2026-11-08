// Step 2 — the People who can appear on Covers. The owner's own card is created
// server-side (`ensureOwnerPerson`) and cannot be removed, so the roster starts at
// one.
//
// The card list, the photo uploads, and the no-name fallback are Settings → People's
// own form: each card saves itself, so this screen's action only moves on. The roster
// is mirrored into the wizard because this step unmounts when it does, and remounting
// must not lose a Person added a moment ago.

'use client';

import { Users } from 'lucide-react';
import { PeopleForm } from '@/components/settings/people-form';
import type { PeopleFormProps, PersonEditorValue } from '@/components/settings/people-types';
import {
  OnboardingActions,
  OnboardingPrimaryAction,
  OnboardingStepHeader,
} from './onboarding-layout';

export function OnboardingPeopleStep({
  people,
  roster,
  ownerImageUrl,
  onRosterChange,
  onDone,
}: {
  people: PeopleFormProps;
  roster: PersonEditorValue[];
  /** The photo uploaded on the previous screen, identifying the owner's card here. */
  ownerImageUrl: string | null;
  onRosterChange: (people: PersonEditorValue[]) => void;
  onDone: () => void;
}) {
  return (
    <section>
      <OnboardingStepHeader eyebrow="Optional" title="Put people on your Covers">
        Add a Person with photos, then use their exact name in a music request to put them on that
        Session&apos;s Cover.
      </OnboardingStepHeader>

      <div className="mt-5">
        <PeopleForm
          {...people}
          initialPeople={roster}
          ownerImageUrl={ownerImageUrl}
          onRosterChange={onRosterChange}
        />
      </div>

      {/* One action: every card above saves itself, so a second "save and continue"
          button would promise a write this screen does not make. */}
      <OnboardingActions>
        <OnboardingPrimaryAction label="Continue" onClick={onDone} />
      </OnboardingActions>

      <div className="mt-5 flex items-start gap-3 rounded-card-sm border border-lamp/35 bg-lamp/[0.07] px-4 py-3 text-[13.5px]">
        <Users className="mt-[2px] h-[17px] w-[17px] flex-none text-lamp" aria-hidden />
        <p className="text-muted">
          <b className="font-semibold text-paper">Skipping is fine.</b> People only appear on
          Tailored Cover Art, and you can add them later in{' '}
          <b className="font-semibold text-paper">Settings › People</b>.
        </p>
      </div>
    </section>
  );
}
