// Own-generation reporting: what the music model actually produced
// for an owner, read from the permanent output ledger and the request ledger —
// never from live Tracks (deletable) or diagnostic events (prunable). Read-only:
// nothing here takes part in spending admission.

import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  generationOutputs,
  generationRequests,
  listeningOccurrences,
  trackAudioAssets,
} from '../schema';
import type { DbOrTx } from '../transactions';
import { resolveReporting, type ListeningStatsQuery } from './listening-repo';

export interface GenerationStats {
  /** Tracks that first became playable in the range, deleted ones included. */
  generatedTracks: number;
  /**
   * Of `generatedTracks`, those reconstructed from Tracks that still existed when
   * the ledger began. Their era's deleted Tracks are uncounted, so any total
   * including them is a floor, not a lifetime figure.
   */
  historicalTracks: number;
  /** Generated Tracks whose final audio was never stored. Still generated. */
  storageFailures: number;
  /** Accepted music-model attempts that ended in failure. An attempt is not a Track. */
  failedAttempts: number;
  /** Generated since listening collection began, with no credited listening at all. */
  neverHeardTracks: number;
  /** Generated before listening collection began: heard or not cannot be known. */
  unknownCoverageTracks: number;
}

export async function getGenerationStats(
  db: Database,
  input: ListeningStatsQuery,
): Promise<GenerationStats> {
  const { from, collectionStartedAt } = await resolveReporting(db, input);
  const g = generationOutputs;
  const since = from?.toISOString() ?? null;
  const collected = collectionStartedAt.toISOString();

  const outputs = await db.execute<{
    generated: string;
    historical: string;
    storage_failures: string;
    never_heard: string;
    unknown_coverage: string;
  }>(sql`
    select count(*) as generated,
      count(*) filter (where ${g.historical}) as historical,
      count(*) filter (where ${g.storageFailedAt} is not null) as storage_failures,
      count(*) filter (where ${g.firstPlayableAt} < ${collected}::timestamptz) as unknown_coverage,
      count(*) filter (
        where ${g.firstPlayableAt} >= ${collected}::timestamptz
          and not exists (
            select 1 from ${listeningOccurrences} as heard
            where heard.owner_user_id = ${g.ownerUserId}
              and heard.analytics_track_id = ${g.analyticsTrackId}
              and heard.listened_ms > 0
          )
      ) as never_heard
    from ${g}
    where ${g.ownerUserId} = ${input.ownerUserId}
      and (${since}::timestamptz is null or ${g.firstPlayableAt} >= ${since}::timestamptz)
  `);

  const r = generationRequests;
  const failures = await db.execute<{ failed: string }>(sql`
    select count(*) as failed
    from ${r}
    where ${r.ownerUserId} = ${input.ownerUserId}
      and ${r.status} = 'failed'
      and (${since}::timestamptz is null or ${r.createdAt} >= ${since}::timestamptz)
  `);

  const row = outputs.rows[0];
  return {
    generatedTracks: Number(row?.generated ?? 0),
    historicalTracks: Number(row?.historical ?? 0),
    storageFailures: Number(row?.storage_failures ?? 0),
    failedAttempts: Number(failures.rows[0]?.failed ?? 0),
    neverHeardTracks: Number(row?.never_heard ?? 0),
    unknownCoverageTracks: Number(row?.unknown_coverage ?? 0),
  };
}

/**
 * The final-audio download for this Track was given up on. Its output stays
 * counted; only a Track with no stored audio can carry the mark.
 */
export async function recordOutputStorageFailure(db: DbOrTx, trackId: string): Promise<void> {
  await db.execute(sql`
    update ${generationOutputs}
    set storage_failed_at = coalesce(storage_failed_at, now())
    where track_id = ${trackId}
      and not exists (
        select 1 from ${trackAudioAssets} as stored
        where stored.track_id = ${trackId} and stored.asset_type = 'local_original'
      )
  `);
}

/** Stored audio landed after all: a later retry succeeded where an earlier run gave up. */
export async function clearOutputStorageFailure(db: DbOrTx, trackId: string): Promise<void> {
  await db.execute(sql`
    update ${generationOutputs} set storage_failed_at = null
    where track_id = ${trackId} and storage_failed_at is not null
  `);
}
