// The Your stats read shared by the page's server render and its API route, so
// the first paint and every range switch answer from the same query.

import { getCachedListeningStats, getGenerationStats, getUsageLimits } from '@liedmotif/db';
import type { ListeningRange, ListeningStatsData } from '@liedmotif/shared';
import { getDb } from '@/lib/db';

export async function loadListeningStats(
  ownerUserId: string,
  range: ListeningRange,
): Promise<ListeningStatsData> {
  const db = getDb();
  const { resetTimezone } = await getUsageLimits(db);
  const query = { ownerUserId, range, now: new Date(), timezone: resetTimezone };
  const [stats, generation] = await Promise.all([
    getCachedListeningStats(db, query),
    getGenerationStats(db, query),
  ]);
  return {
    ...stats,
    generation,
    from: stats.from?.toISOString() ?? null,
    collectionStartedAt: stats.collectionStartedAt.toISOString(),
  };
}
