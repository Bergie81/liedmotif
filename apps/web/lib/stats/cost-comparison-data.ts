// The Admin cost comparison read shared by the Your stats page and its API
// route. Admin-only by its callers' guards; aggregates ONLY — the
// shape here is the whole payload, so no content field may ever be added to it.

import {
  getCostComparison,
  getUnitCosts,
  getUsageLimits,
  reportingRangeStart,
  type SpendCounts,
} from '@liedmotif/db';
import type { CostComparisonData, CostCounts, ListeningRange } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers/providers';
import { providerTasksToTracks } from '@/lib/budget/track-units';

export async function loadCostComparison(
  adminUserId: string,
  range: ListeningRange,
): Promise<CostComparisonData> {
  const db = getDb();
  // Cost periods follow the budget calendar, never the viewer's reporting timezone.
  const { resetTimezone: timezone } = await getUsageLimits(db);
  const from = reportingRangeStart(new Date(), timezone, range);
  const [comparison, unitCosts] = await Promise.all([
    getCostComparison(db, { adminUserId, since: from ?? new Date(0) }),
    getUnitCosts(db),
  ]);

  const tracksPerCall = getTypicalTracksPerMusicRequest();
  const counts = (spend: SpendCounts): CostCounts => ({
    tracks: providerTasksToTracks(spend.tasks, tracksPerCall),
    covers: spend.covers,
  });
  const sum = (groups: CostCounts[]): CostCounts => ({
    tracks: groups.reduce((total, group) => total + group.tracks, 0),
    covers: groups.reduce((total, group) => total + group.covers, 0),
  });

  const own = counts(comparison.own);
  const formerMembers = counts(comparison.formerMembers);
  const perMember = comparison.perMember.map((member) => ({
    userId: member.userId,
    name: member.name,
    ...counts(member),
  }));
  const members = sum([...perMember, formerMembers]);
  return {
    range,
    timezone,
    from: from?.toISOString() ?? null,
    unitCosts,
    own,
    members,
    formerMembers,
    total: sum([own, members]),
    perMember,
  };
}
