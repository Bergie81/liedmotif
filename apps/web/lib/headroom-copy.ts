// The cost refusal copy for Start Session / More Like This (the creation
// headroom) and Change Vibe (no music call fits), pure so every case can be
// asserted without a database.

import { oneTimeBudgetUsedUpMessage, type CreationHeadroomDecision } from '@liedmotif/shared';
import { trackNoun } from '@/components/app-shell-model';

const WAY_OUT = 'Resume one of your sessions from Sessions or play your Library instead.';

/** The user-facing prompt shown when the headroom gate refuses a new session. */
export const HEADROOM_BLOCKED_MESSAGE = `You have reached your generation headroom for now. ${WAY_OUT}`;

/**
 * The used-up refusal, honest about who can fix it: the Admin gets
 * the instance message; a Member is told whether their OWN budget or the
 * shared one binds — neither message implies they could raise a limit. A
 * One-time budget (`window: 'total'`, only ever a Member's own) has no
 * rollover to wait for, so that refusal names the Admin instead.
 */
export function headroomBlockedMessage(
  decision: Pick<CreationHeadroomDecision, 'scope' | 'window'>,
  adminName: string | null,
): string {
  if (decision.window === 'total') return `${oneTimeBudgetUsedUpMessage(adminName)} ${WAY_OUT}`;
  switch (decision.scope) {
    case 'member':
      return `You have used your tracks for now — new tracks when your budget resets. ${WAY_OUT}`;
    case 'pool':
      return `The shared budget is used up right now — new tracks resume when it resets. ${WAY_OUT}`;
    case 'instance':
      return HEADROOM_BLOCKED_MESSAGE;
  }
}

export interface HeadroomCopyContext {
  /** Who a Member is told to ask when waiting cannot help. */
  adminName: string | null;
  /** The Instance timezone every window resets in. */
  resetTimezone: string;
}

const PERIOD = { day: ' today', month: ' this month' } as const;
const RESET = { day: 'at midnight', month: 'on the 1st' } as const;
const WINDOW_NAME = { day: 'daily', month: 'monthly' } as const;

/**
 * A refused new Session, in numbers: what it needs, what is left, and when
 * more comes back. When the binding window's own cap is below what a Session
 * needs no reset helps, so the text says so instead of promising one. A Member
 * with nothing left keeps the used-up texts; the Pool is always "the shared
 * budget", never something the Member could change.
 */
export function creationHeadroomMessage(
  decision: CreationHeadroomDecision,
  { adminName, resetTimezone }: HeadroomCopyContext,
): string {
  const { scope, window, remainingTracks, minHeadroomTracks, windowCapTracks } = decision;
  const needs = `A new Session needs ${minHeadroomTracks} ${trackNoun(minHeadroomTracks)}`;
  const admin = adminName ?? 'the Admin';

  if (window === 'total') {
    if (remainingTracks === 0) return headroomBlockedMessage(decision, adminName);
    return `${needs}; you have ${remainingTracks} left. Your budget doesn’t reset — ask ${admin} for more. ${WAY_OUT}`;
  }

  if (windowCapTracks < minHeadroomTracks) {
    const noWait = `so waiting won’t help.`;
    switch (scope) {
      case 'instance':
        return `${needs}, but your ${WINDOW_NAME[window]} limit is only ${windowCapTracks}, ${noWait} Adjust your cost limits to start one. ${WAY_OUT}`;
      case 'member':
        return `${needs}, but your ${WINDOW_NAME[window]} budget is only ${windowCapTracks}, ${noWait} Ask ${admin} for more. ${WAY_OUT}`;
      case 'pool':
        return `${needs}, but the shared ${WINDOW_NAME[window]} budget is only ${windowCapTracks}, ${noWait} Ask ${admin} about it. ${WAY_OUT}`;
    }
  }

  if (remainingTracks === 0 && scope !== 'instance') {
    return headroomBlockedMessage(decision, adminName);
  }
  const left = remainingTracks === 0 ? 'none' : String(remainingTracks);
  const holder = scope === 'pool' ? 'the shared budget has' : 'you have';
  return `${needs}; ${holder} ${left} left${PERIOD[window]}. More Tracks ${RESET[window]} (${resetTimezone}). ${WAY_OUT}`;
}
