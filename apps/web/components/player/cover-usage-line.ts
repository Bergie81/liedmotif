// The cover budget line, as the cover dialog shows it: on the dialog, and on
// the Assistant's card for a new cover.

import type { SessionCoverUsage } from '@liedmotif/shared';

/** Show the month counter only when the month window is the binding budget. */
function monthWindowBinds(usage: SessionCoverUsage): boolean {
  if (usage.limitMonth === null || usage.limitDay === null) return false;
  return usage.limitMonth - usage.usedMonth < usage.limitDay - usage.usedDay;
}

/** The line, or null when there is no ceiling: a bare count tells the user nothing actionable. */
export function coverUsageLine(usage: SessionCoverUsage): string | null {
  if (usage.oneTime) return `Covers: ${usage.usedDay} of ${usage.limitDay} in total`;
  if (usage.limitDay === null) return null;
  const month = monthWindowBinds(usage)
    ? ` · This month: ${usage.usedMonth} of ${usage.limitMonth}`
    : '';
  return `Covers today: ${usage.usedDay} of ${usage.limitDay}${month}`;
}
