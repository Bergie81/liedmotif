// The cost refusal copy for Start Session / More Like This (the creation
// headroom) and Change Vibe (no music call fits), pure so the four cases can be
// asserted without a database.

import { oneTimeBudgetUsedUpMessage, type CreationHeadroomDecision } from '@liedmotif/shared';

const WAY_OUT = 'Resume one of your sessions from Sessions or play your Library instead.';

/** The user-facing prompt shown when the headroom gate refuses a new session. */
export const HEADROOM_BLOCKED_MESSAGE = `You have reached your generation headroom for now. ${WAY_OUT}`;

/**
 * The headroom refusal, honest about who can fix it: the Admin gets
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
