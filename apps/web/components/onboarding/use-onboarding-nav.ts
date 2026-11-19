'use client';

// The one definition of onboarding navigation, shared by the Admin and Member
// wizards: a bounded step index, the furthest-reached watermark the rail
// gates on, and the scroll reset each step change performs.

import { useCallback, useState } from 'react';
import { mergePersonNames } from '@/components/settings/people-form-model';
import type { PersonEditorValue } from '@/components/settings/people-types';
import { loadPeopleNames } from '@/lib/settings/settings-client';

export function useOnboardingNav<Step>(steps: readonly Step[]) {
  const [index, setIndex] = useState(0);
  const [furthest, setFurthest] = useState(0);

  const go = useCallback(
    (next: number) => {
      const bounded = Math.min(Math.max(next, 0), steps.length - 1);
      setIndex(bounded);
      setFurthest((current) => Math.max(current, bounded));
      window.scrollTo({ top: 0 });
    },
    [steps.length],
  );
  const advance = useCallback(() => go(index + 1), [go, index]);

  return {
    index,
    furthest,
    go,
    advance,
    step: steps[index]!,
    previous: index > 0 ? steps[index - 1] : undefined,
  };
}

/**
 * Saving the profile can rename the owner Person server-side — it follows the
 * User name until it is given one of its own — so the roster is re-read before
 * the People step introduces the owner by it. Best-effort: a failed read
 * leaves the cards showing their loaded names, which stay editable by hand.
 */
export async function refreshRosterNames(
  updateRoster: (update: (people: PersonEditorValue[]) => PersonEditorValue[]) => void,
): Promise<void> {
  const fromServer = await loadPeopleNames();
  if (fromServer) updateRoster((people) => mergePersonNames(people, fromServer));
}
