// The pure shapes behind the Assistant controls on Settings → Members: what a
// Member's switch and daily allowance show, whether each is the instance
// default or a value the Admin set for that Member, and a typed allowance
// checked against the range the routes accept.

import {
  ASSISTANT_DAILY_MESSAGES_MAX,
  ASSISTANT_DAILY_MESSAGES_MIN,
  type AssistantAccess,
  type MemberAssistantAccess,
} from '@liedmotif/shared';
import { wholeLimitNumber } from '@/lib/track-units';

/** Where a shown value comes from: the instance default, or the Member's own. */
export type AccessSource = 'default' | 'own';

interface SourcedValue<T> {
  value: T;
  source: AccessSource;
}

export interface MemberAssistantView {
  enabled: SourcedValue<boolean>;
  dailyMessages: SourcedValue<number>;
}

function sourced<T>(own: T | undefined, instanceDefault: T): SourcedValue<T> {
  return own === undefined
    ? { value: instanceDefault, source: 'default' }
    : { value: own, source: 'own' };
}

/**
 * One Member's access as the screen shows it. A value the Admin set stays the
 * Member's own even while it equals the default: it will not move when the
 * default does.
 */
export function memberAssistantView(
  instanceDefault: AssistantAccess,
  own: MemberAssistantAccess,
): MemberAssistantView {
  return {
    enabled: sourced(own.enabled, instanceDefault.enabled),
    dailyMessages: sourced(own.dailyMessages, instanceDefault.dailyMessages),
  };
}

const ACCESS_SOURCE_LABELS: Record<AccessSource, string> = {
  default: 'Default',
  own: 'Set for this Member',
};

export function accessSourceLabel(source: AccessSource): string {
  return ACCESS_SOURCE_LABELS[source];
}

/** A daily allowance as typed: a whole number inside the accepted range, or why not. */
export function parseDailyMessages(raw: string): { value: number } | { error: string } {
  const value = wholeLimitNumber(raw);
  if (
    value === null ||
    value < ASSISTANT_DAILY_MESSAGES_MIN ||
    value > ASSISTANT_DAILY_MESSAGES_MAX
  ) {
    return {
      error: `Enter a whole number from ${ASSISTANT_DAILY_MESSAGES_MIN} to ${ASSISTANT_DAILY_MESSAGES_MAX}.`,
    };
  }
  return { value };
}
