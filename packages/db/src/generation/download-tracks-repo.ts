// Track selection for the download routes. Read-only: resolves the owned
// tracks whose downloaded, tagged local finals can be served as attachments —
// one track for `/api/tracks/<id>/download`, a session's play-ordered set for
// the session zip.

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  downloadableTrackColumns,
  MAX_EXPORT_TRACKS,
  servableLocalFinalConditions,
  type DownloadableTrack,
} from './audio-asset-predicates';
import { activitySessionQueueItems, generationRequests, tracks, trackAudioAssets } from '../schema';

export type { DownloadableTrack } from './audio-asset-predicates';

/**
 * A Session's downloadable Tracks, strictly owner-scoped (a foreign/unknown
 * session reads as empty — the route's uniform-404 posture). Downloadable =
 * ready, not disliked, and carrying a servable `local_original`; stream-only
 * tracks are excluded by design (no local bytes). Ordered by queue
 * position with never-enqueued reroll siblings last, so the zip's numbering
 * follows play order where one exists, and bounded by `MAX_EXPORT_TRACKS`.
 */
export async function getOwnedSessionDownloadTracks(
  db: Database,
  args: { ownerUserId: string; sessionId: string },
): Promise<DownloadableTrack[]> {
  return db
    .select(downloadableTrackColumns())
    .from(generationRequests)
    .innerJoin(tracks, eq(tracks.generationRequestId, generationRequests.id))
    .innerJoin(
      trackAudioAssets,
      and(eq(trackAudioAssets.trackId, tracks.id), servableLocalFinalConditions()),
    )
    .leftJoin(
      activitySessionQueueItems,
      and(
        eq(activitySessionQueueItems.activitySessionId, generationRequests.activitySessionId),
        eq(activitySessionQueueItems.trackId, tracks.id),
      ),
    )
    .where(
      and(
        eq(generationRequests.activitySessionId, args.sessionId),
        eq(generationRequests.ownerUserId, args.ownerUserId),
        eq(tracks.ownerUserId, args.ownerUserId),
        eq(tracks.status, 'ready'),
        isNull(tracks.dislikedAt),
      ),
    )
    .orderBy(
      sql`${activitySessionQueueItems.position} asc nulls last`,
      asc(tracks.createdAt),
      asc(tracks.id),
    )
    .limit(MAX_EXPORT_TRACKS);
}

/**
 * One owned track's downloadable local final (same qualifying rules as the
 * session selection), or null — a cross-owner, missing, disliked, or
 * stream-only track all read as absent (the route's uniform-404 posture).
 */
export async function getOwnedDownloadableTrack(
  db: Database,
  args: { ownerUserId: string; trackId: string },
): Promise<DownloadableTrack | null> {
  const [row] = await db
    .select(downloadableTrackColumns())
    .from(tracks)
    .innerJoin(
      trackAudioAssets,
      and(eq(trackAudioAssets.trackId, tracks.id), servableLocalFinalConditions()),
    )
    .where(
      and(
        eq(tracks.id, args.trackId),
        eq(tracks.ownerUserId, args.ownerUserId),
        eq(tracks.status, 'ready'),
        isNull(tracks.dislikedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
