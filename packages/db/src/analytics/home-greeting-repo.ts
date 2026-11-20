// The few facts Home's headline may greet an owner with: how much music they
// have made and when they last played it. Read on every Home load, so it is one
// cheap round trip over indexed owner columns.

import { sql } from 'drizzle-orm';
import { generationOutputs, listeningOccurrences } from '../schema';
import type { DbOrTx } from '../transactions';

export interface HomeGreetingFacts {
  /** Tracks the music model produced for the owner, deleted ones included. */
  totalTracks: number;
  /** Of those, the ones that became playable in the seven days before `now`. */
  tracksThisWeek: number;
  /** The end of the owner's most recent audible play of their own Tracks, or null if there was none. */
  lastListenedAt: Date | null;
}

const WEEK_MS = 7 * 86_400_000;

export async function getHomeGreetingFacts(
  db: DbOrTx,
  input: { ownerUserId: string; now: Date },
): Promise<HomeGreetingFacts> {
  const g = generationOutputs;
  const l = listeningOccurrences;
  const weekAgo = new Date(input.now.getTime() - WEEK_MS).toISOString();
  const result = await db.execute<{
    total: string;
    this_week: string;
    last_listened_at: string | Date | null;
  }>(sql`
    select
      (select count(*) from ${g} where ${g.ownerUserId} = ${input.ownerUserId}) as total,
      (select count(*) from ${g}
        where ${g.ownerUserId} = ${input.ownerUserId}
          and ${g.firstPlayableAt} >= ${weekAgo}::timestamptz) as this_week,
      (select max(${l.lastListenedAt}) from ${l}
        where ${l.ownerUserId} = ${input.ownerUserId} and ${l.listenedMs} > 0) as last_listened_at
  `);
  const row = result.rows[0];
  return {
    totalTracks: Number(row?.total ?? 0),
    tracksThisWeek: Number(row?.this_week ?? 0),
    lastListenedAt: row?.last_listened_at ? new Date(row.last_listened_at) : null,
  };
}
