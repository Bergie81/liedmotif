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

const rolling = (figures: BudgetFigures) =>
  `${left(figures.tracksDay, 'Tracks')} today, ${left(figures.tracksMonth, 'Tracks')} this month. ${left(figures.coversDay, 'covers')} today, ${left(figures.coversMonth, 'covers')} this month.`;

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
      return [
        `Instance limit: ${instanceWindow(tracks.dailyTracksUsed, tracks.dailyTracksLimit, 'today', 'Tracks')}, ${instanceWindow(tracks.monthlyTracksUsed, tracks.monthlyTracksLimit, 'this month', 'Tracks')}.`,
        sentence(
          `${instanceWindow(covers.usedDay, covers.limitDay, 'today', 'covers')}, ${instanceWindow(covers.usedMonth, covers.limitMonth, 'this month', 'covers')}`,
        ),
      ].join(' ');
    },
  };
}
