// Saved Tracks whose final-audio download was given up on. `download-final-audio`
// marks the give-up on the Track's ledger row (`storage_failed_at`) on its last
// Graphile attempt; nothing else ever enqueues that download again, so a Track
// Saved before or after the give-up would lose its audio when the provider URL
// expires.

import { and, asc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../transactions';
import { generationOutputs, tracks, trackAudioAssets } from '../schema';

/**
 * How long the provider keeps a generated final reachable (sunoapi.org: 15
 * days). Past it the sealed URL can only fail, so a retry would spend egress
 * attempts on nothing.
 */
export const PROVIDER_FINAL_RETENTION_MS = 15 * 24 * 60 * 60_000;

/**
 * Saved `streamable` Tracks whose download gave up, that still hold a sealed
 * provider final and no local copy, and were generated inside the provider's
 * retention window. Oldest first: those expire soonest.
 *
 * The give-up mark is what makes this safe to re-enqueue: it is set only once
 * the last attempt failed, so a download still in its own retry loop is never
 * selected. `savedAt` alone covers Favorites (`favoritedAt ⇒ savedAt`).
 */
export async function listGivenUpSavedDownloads(
  db: DbOrTx,
  args: { now: Date; limit?: number },
): Promise<string[]> {
  const since = new Date(args.now.getTime() - PROVIDER_FINAL_RETENTION_MS);
  const rows = await db
    .select({ trackId: tracks.id })
    .from(tracks)
    .innerJoin(
      generationOutputs,
      and(eq(generationOutputs.trackId, tracks.id), isNotNull(generationOutputs.storageFailedAt)),
    )
    .innerJoin(
      trackAudioAssets,
      and(
        eq(trackAudioAssets.trackId, tracks.id),
        eq(trackAudioAssets.assetType, 'provider_final'),
        isNotNull(trackAudioAssets.encryptedSourceUrl),
      ),
    )
    .where(
      and(
        eq(tracks.status, 'streamable'),
        isNotNull(tracks.savedAt),
        isNull(tracks.dislikedAt),
        gte(tracks.createdAt, since),
        sql`not exists (
          select 1 from ${trackAudioAssets} as stored
          where stored.track_id = ${tracks.id} and stored.asset_type = 'local_original'
        )`,
      ),
    )
    .orderBy(asc(tracks.createdAt), asc(tracks.id))
    .limit(args.limit ?? 50);
  return rows.map((row) => row.trackId);
}
