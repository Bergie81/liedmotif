// `budget`: how many Tracks the asking user can still generate. The figures
// are the ones the app shows: a Member's come from the Settings › My budget
// loader, the Admin's from the readout behind the Tracks-left chip.

import type { LlmTool } from '@liedmotif/providers';
import { noToolInputSchema, type NoToolInput } from '@liedmotif/shared';
import { loadMyBudgetData } from '@/lib/my-budget-data';
import type { BudgetFigures, BudgetUsage } from '@/lib/my-budget-model';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers';
import { getOwnerUsageTracks } from '@/lib/sessions';
import { BUDGET_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

const left = ({ remaining, limit }: { remaining: number; limit: number }) =>
  `${remaining} of ${limit} Tracks left`;

const rolling = (figures: BudgetFigures) =>
  `${left(figures.tracksDay)} today, ${left(figures.tracksMonth)} this month.`;

function ownBudget(yours: BudgetUsage): string {
  return yours.kind === 'oneTime'
    ? `${left(yours.tracks)}. This budget is one-time: it does not refill.`
    : rolling(yours.figures);
}

/** One window of the Admin's own bound; a null limit is a ceiling that is switched off. */
function instanceWindow(used: number, limit: number | null, period: string): string {
  return limit === null
    ? `no limit set ${period} (${used} Tracks generated)`
    : `${left({ remaining: Math.max(0, limit - used), limit })} ${period}`;
}

export function createBudgetTool({ db, userId, role }: AssistantAsker): LlmTool<NoToolInput> {
  return {
    name: BUDGET_TOOL_NAME,
    description:
      'How many Tracks the user can still generate today and this month, counted in Tracks.',
    inputSchema: noToolInputSchema,
    async execute() {
      const member = role === 'member' ? await loadMyBudgetData(userId) : null;
      if (member) {
        return [
          `Your budget: ${ownBudget(member.yours)}`,
          `Shared budget of all Members: ${rolling(member.shared)}`,
          'New music is generated only while both have Tracks left.',
        ].join('\n');
      }
      const usage = await getOwnerUsageTracks(db, userId, getTypicalTracksPerMusicRequest());
      const today = instanceWindow(usage.dailyTracksUsed, usage.dailyTracksLimit, 'today');
      const month = instanceWindow(usage.monthlyTracksUsed, usage.monthlyTracksLimit, 'this month');
      return `Instance limit: ${today}, ${month}.`;
    },
  };
}
