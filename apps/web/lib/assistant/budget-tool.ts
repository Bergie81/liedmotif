// `budget`: how many Tracks and covers the asking user can still generate. The
// figures are the ones the app shows: a Member's come from the Settings › My
// budget loader, the Admin's from the readouts behind the Tracks-left chip and
// the Settings page's cover usage.

import { getAdminCoverUsage, getUsageLimits } from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { noToolInputSchema, type NoToolInput } from '@liedmotif/shared';
import { loadMyBudgetData } from '@/lib/my-budget-data';
import type { BudgetFigures, BudgetUsage, BudgetWindow } from '@/lib/my-budget-model';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers';
import { getOwnerUsageTracks } from '@/lib/sessions';
import { BUDGET_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

type Unit = 'Tracks' | 'covers';

const left = ({ remaining, limit }: Pick<BudgetWindow, 'remaining' | 'limit'>, unit: Unit) =>
  `${remaining} of ${limit} ${unit} left`;

const dayAndMonth = (day: BudgetWindow, month: BudgetWindow, unit: Unit) =>
  `${left(day, unit)} today, ${left(month, unit)} this month.`;

const rolling = (figures: BudgetFigures) =>
  `${dayAndMonth(figures.tracksDay, figures.tracksMonth, 'Tracks')} ${dayAndMonth(figures.coversDay, figures.coversMonth, 'covers')}`;

function ownBudget(yours: BudgetUsage): string {
  return yours.kind === 'oneTime'
    ? `${left(yours.tracks, 'Tracks')}. ${left(yours.covers, 'covers')}. This budget is one-time: it does not refill.`
    : rolling(yours.figures);
}

/** One window of the Admin's own bound; a null limit is a ceiling that is switched off. */
function instanceWindow(used: number, limit: number | null, period: string, unit: Unit): string {
  return limit === null
    ? `no limit set ${period} (${used} ${unit} generated)`
    : `${left({ remaining: Math.max(0, limit - used), limit }, unit)} ${period}`;
}

interface InstanceUsage {
  usedDay: number;
  limitDay: number | null;
  usedMonth: number;
  limitMonth: number | null;
}

const instanceDayAndMonth = (usage: InstanceUsage, unit: Unit) =>
  `${instanceWindow(usage.usedDay, usage.limitDay, 'today', unit)}, ${instanceWindow(usage.usedMonth, usage.limitMonth, 'this month', unit)}`;

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

export function createBudgetTool({ db, userId, role }: AssistantAsker): LlmTool<NoToolInput> {
  return {
    name: BUDGET_TOOL_NAME,
    description:
      'How many Tracks and covers the user can still generate today and this month, counted in Tracks and in covers.',
    inputSchema: noToolInputSchema,
    async execute() {
      const member = role === 'member' ? await loadMyBudgetData(userId) : null;
      if (member) {
        return [
          `Your budget: ${ownBudget(member.yours)}`,
          `Shared budget of all Members: ${rolling(member.shared)}`,
          'New music and covers are generated only while both budgets have some left.',
        ].join('\n');
      }
      const [tracks, covers] = await Promise.all([
        getOwnerUsageTracks(db, userId, getTypicalTracksPerMusicRequest()),
        getUsageLimits(db).then((instanceLimits) =>
          getAdminCoverUsage(db, {
            ownerUserId: userId,
            instanceLimits,
            now: new Date(),
            concurrently: true,
          }),
        ),
      ]);
      const trackWindows = instanceDayAndMonth(
        {
          usedDay: tracks.dailyTracksUsed,
          limitDay: tracks.dailyTracksLimit,
          usedMonth: tracks.monthlyTracksUsed,
          limitMonth: tracks.monthlyTracksLimit,
        },
        'Tracks',
      );
      return `Instance limit: ${trackWindows}. ${sentence(instanceDayAndMonth(covers, 'covers'))}`;
    },
  };
}
