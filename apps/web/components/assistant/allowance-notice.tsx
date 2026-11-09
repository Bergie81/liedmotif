'use client';

// What the panel says about a Member's daily message allowance: nothing while
// plenty is left, how many are left once few are, and when the field opens
// again once none is.

import { useEffect, useState } from 'react';
import type { AssistantStanding } from '@liedmotif/shared';
import { AlertBanner } from '@/components/ui/design-system';

type Allowance = NonNullable<AssistantStanding['allowance']>;

/** From this many messages left, the panel says how many. */
const ASSISTANT_LOW_MESSAGES = 5;

/**
 * Today's allowance, or `null` for a user who has none and once its day is
 * over: a count from yesterday says nothing about today, and the next response
 * brings today's.
 */
export function useAllowance(standing: AssistantStanding | null): Allowance | null {
  const allowance = standing?.allowance ?? null;
  const resetsAt = allowance?.resetsAt ?? null;
  // The day that has ended, named by the instant it ended at.
  const [endedDay, setEndedDay] = useState<string | null>(null);

  useEffect(() => {
    if (!resetsAt) return;
    const look = () => {
      const wait = Date.parse(resetsAt) - Date.now();
      if (wait <= 0) setEndedDay(resetsAt);
      return wait;
    };
    const wait = look();
    if (wait <= 0) return;
    const timer = setTimeout(look, wait);
    // A device that slept holds its timers back; coming back into view is the
    // moment to look again.
    document.addEventListener('visibilitychange', look);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', look);
    };
  }, [resetsAt]);

  return allowance && endedDay !== resetsAt ? allowance : null;
}

/** The viewer's own clock time for an instant: "16:05" or "4:05 PM", as their locale writes it. */
function localTime(instant: string): string {
  return new Date(instant).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function AllowanceNotice({ allowance }: { allowance: Allowance | null }) {
  if (!allowance || allowance.remaining > ASSISTANT_LOW_MESSAGES) return null;
  if (allowance.remaining === 0) {
    return (
      <AlertBanner>
        You have used all of today&apos;s messages. You can ask again at{' '}
        {localTime(allowance.resetsAt)}.
      </AlertBanner>
    );
  }
  return (
    <p role="status" className="px-1 text-[12.5px] text-muted">
      {allowance.remaining === 1 ? '1 message' : `${allowance.remaining} messages`} left today.
    </p>
  );
}
