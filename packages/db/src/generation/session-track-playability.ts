import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { activitySessionQueueItems, generationRequests, trackAudioAssets, tracks } from '../schema';

/** Left-join target for a Track's slot in the Session its GenerationRequest belongs to. */
export const sessionTrackQueueEdge = and(
  eq(activitySessionQueueItems.trackId, tracks.id),
  eq(activitySessionQueueItems.activitySessionId, generationRequests.activitySessionId),
);

/**
 * Card counts, listing, and selection share this predicate, so every counted
 * Track is one the listener can select. It reads the Track's Queue slot, so the
 * query must left-join `sessionTrackQueueEdge`.
 */
export function playableSessionTrackCondition(ownerUserId: string | SQL) {
  return and(
    eq(tracks.ownerUserId, ownerUserId),
    inArray(tracks.status, ['ready', 'streamable']),
    isNull(tracks.dislikedAt),
    or(isNull(activitySessionQueueItems.id), ne(activitySessionQueueItems.state, 'rejected')),
    sql`exists (
      select 1 from ${trackAudioAssets}
      where ${trackAudioAssets.trackId} = ${tracks.id}
        and ${trackAudioAssets.isPlayable}
        and (
          (${trackAudioAssets.assetType} = 'local_original' and ${trackAudioAssets.storageKey} is not null)
          or (${trackAudioAssets.assetType} = 'provider_stream' and ${trackAudioAssets.encryptedSourceUrl} is not null)
        )
    )`,
  );
}
