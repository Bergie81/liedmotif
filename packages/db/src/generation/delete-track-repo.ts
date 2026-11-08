import { and, eq, inArray } from 'drizzle-orm';
import { LIVE_QUEUE_ITEM_STATES } from '@liedmotif/shared';
import type { Database } from '../client';
import { activitySessionQueueItems, tracks } from '../schema';
import { withTransaction, type Transaction } from '../transactions';
import { purgeTrackMembershipsInTx } from '../playlists/membership-purge';
import { queueTrackAudioDeletion } from './deletion-queue-repo';

export const USER_DELETE_REASON = 'user_delete';

export interface DeleteTrackResult {
  alreadyDeleted: boolean;
}

/** Permanently remove one owned Track from every playback/read surface and queue
 * its audio for immediate file deletion. Retention flags do not protect against
 * an explicit owner delete. */
export function deleteTrack(
  db: Database,
  args: { ownerUserId: string; trackId: string; now?: Date },
): Promise<DeleteTrackResult | null> {
  return withTransaction(db, (tx) => deleteTrackInTx(tx, args));
}

export async function deleteTrackInTx(
  tx: Transaction,
  args: { ownerUserId: string; trackId: string; now?: Date },
): Promise<DeleteTrackResult | null> {
  const [track] = await tx
    .select({ status: tracks.status })
    .from(tracks)
    .where(and(eq(tracks.id, args.trackId), eq(tracks.ownerUserId, args.ownerUserId)))
    .limit(1)
    .for('update');
  if (!track) return null;
  if (track.status === 'deleted' || track.status === 'rejected') {
    return { alreadyDeleted: true };
  }

  const now = args.now ?? new Date();
  // The cover pointer is cleared with the tombstone: a pointer-bearing
  // tombstone would hold its cover_images row (and file) alive forever, since
  // cover reclamation treats any track reference as live.
  await tx
    .update(tracks)
    .set({ status: 'deleted', savedAt: null, favoritedAt: null, coverImageId: null })
    .where(and(eq(tracks.id, args.trackId), eq(tracks.ownerUserId, args.ownerUserId)));
  // Retention is membership: a deleted track must leave every playlist too.
  await purgeTrackMembershipsInTx(tx, args.trackId);
  await tx
    .update(activitySessionQueueItems)
    .set({ state: 'rejected' })
    .where(
      and(
        eq(activitySessionQueueItems.trackId, args.trackId),
        inArray(activitySessionQueueItems.state, [...LIVE_QUEUE_ITEM_STATES]),
      ),
    );
  await queueTrackAudioDeletion(tx, {
    trackId: args.trackId,
    ownerUserId: args.ownerUserId,
    reason: USER_DELETE_REASON,
    deleteAfter: now,
  });
  return { alreadyDeleted: false };
}
