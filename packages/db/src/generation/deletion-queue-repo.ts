// Deletion-queue writes/reads (the retention/cleanup loop). On the producer side,
// ONE snapshot-then-drop write backs every track-audio cleanup path — Reject's
// delayed purge and explicit Track deletion take it per track, the Session and
// Member reclaims take its batched twin. Inside the caller's transaction it
// snapshots the tracks' CURRENT audio-asset storage keys, queues them, and drops
// the asset rows, so the queued keys and the removed rows can never
// diverge. Objects with no asset rows (voice recordings, cover files) instead
// use `queueStorageObjectDeletion` from their own row-delete transaction. Once a
// producer commits, a queue item is the ONLY remaining reference to the file. The
// consumer side backs the worker's recurring `process-deletion-queue` job: due
// items → `storage.delete` → `processedAt`; a transient delete failure records
// `errorMessageSafe` and leaves the item unprocessed so the next run retries it.

import { and, asc, eq, exists, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { withTransaction, type Transaction } from '../transactions';
import { deletionQueueItems, trackAudioAssets, tracks, user } from '../schema';
import { severTrackAnalyticsLinks } from '../analytics/history-repo';

/**
 * Queue ONE owner-scoped storage object for deletion from the caller's transaction.
 * For objects whose only reference is their own domain row (a voice recording, a
 * cover file), so the row's removal and the file's deletion instruction commit
 * together — there are no `track_audio_assets` rows to snapshot.
 */
export async function queueStorageObjectDeletion(
  tx: Transaction,
  // `ownerUserId: null` = the owner row is already gone (Member delete queues
  // cover bytes after the cascade); the drain worker never reads the owner.
  args: { ownerUserId: string | null; storageKey: string; reason: string; deleteAfter: Date },
): Promise<void> {
  await tx.insert(deletionQueueItems).values({
    ownerUserId: args.ownerUserId,
    storageKey: args.storageKey,
    reason: args.reason,
    deleteAfter: args.deleteAfter,
  });
}

/**
 * Queue ONE owner-scoped storage object for deletion in its own commit, for a
 * caller with no domain transaction to join. A replaced avatar is the case: its
 * only pointer is `user.image`, repointed by Better Auth outside any query this
 * app controls, so there is no row-delete to enqueue alongside — the queue item
 * itself is the durable delete instruction. The immediate `storage.delete` the
 * caller runs afterward stays the fast path; a transient failure there leaves
 * this item for the processor to reclaim.
 */
export async function queueOwnerStorageObjectDeletion(
  db: Database,
  args: { ownerUserId: string; storageKey: string; reason: string; deleteAfter?: Date },
): Promise<void> {
  await withTransaction(db, (tx) =>
    queueStorageObjectDeletion(tx, {
      ownerUserId: args.ownerUserId,
      storageKey: args.storageKey,
      reason: args.reason,
      deleteAfter: args.deleteAfter ?? new Date(),
    }),
  );
}

/**
 * Snapshot-and-queue a track's audio files for deletion, then drop the asset
 * rows — all inside the caller's transaction (the same commit that makes the
 * track unplayable). Owning the snapshot here (instead of trusting keys gathered
 * by an earlier query) means a caller can never delete asset rows without their
 * files being queued. The snapshot covers the keys visible to THIS transaction
 * when it reads — an asset row committed by a concurrent writer between the
 * SELECT and the DELETE is not captured; the concurrent-download case is handled
 * at its source (`queueOrphanedDownloadDeletion`).
 *
 * Every path that removes a Track's content ends here or in the batched twin,
 * so this is also where personal analytics forgets which Track it counted.
 */
export async function queueTrackAudioDeletion(
  tx: Transaction,
  args: { trackId: string; ownerUserId: string; reason: string; deleteAfter: Date },
): Promise<void> {
  const assets = await tx
    .select({ storageKey: trackAudioAssets.storageKey })
    .from(trackAudioAssets)
    .where(eq(trackAudioAssets.trackId, args.trackId));
  const storageKeys = assets
    .map((asset) => asset.storageKey)
    .filter((key): key is string => key != null && key !== '');
  if (storageKeys.length > 0) {
    await tx.insert(deletionQueueItems).values(
      storageKeys.map((storageKey) => ({
        ownerUserId: args.ownerUserId,
        trackId: args.trackId,
        storageKey,
        reason: args.reason,
        deleteAfter: args.deleteAfter,
      })),
    );
  }
  await tx.delete(trackAudioAssets).where(eq(trackAudioAssets.trackId, args.trackId));
  await severTrackAnalyticsLinks(tx, eq(tracks.id, args.trackId));
}

/**
 * `queueTrackAudioDeletion` for a whole SET of tracks, as two statements rather
 * than three per track — what keeps a Session or Member delete from running
 * thousands of round trips while it holds the owner's generation and cover locks.
 * Same snapshot-then-drop guarantee, same transaction: the insert reads
 * `track_audio_assets` joined to the tracks in `scope`, and the delete removes
 * exactly the rows the insert just snapshotted. Each queue item takes its owner
 * from its own track, so a cross-owner set stays correctly attributed.
 */
async function queueScopedTrackAudioDeletion(
  tx: Transaction,
  args: { scope: SQL; reason: string; deleteAfter: Date },
): Promise<void> {
  await tx.execute(sql`
    insert into ${deletionQueueItems} (owner_user_id, track_id, storage_key, reason, delete_after)
    select ${tracks.ownerUserId}, ${trackAudioAssets.trackId}, ${trackAudioAssets.storageKey},
           ${args.reason}, ${args.deleteAfter}
      from ${trackAudioAssets}
      join ${tracks} on ${tracks.id} = ${trackAudioAssets.trackId}
     where ${args.scope}
       and ${trackAudioAssets.storageKey} is not null
       and ${trackAudioAssets.storageKey} <> ''
  `);
  await tx.execute(sql`
    delete from ${trackAudioAssets}
     using ${tracks}
     where ${tracks.id} = ${trackAudioAssets.trackId}
       and ${args.scope}
  `);
}

/**
 * Batched audio queue-and-drop for EVERY track of one owner (Member deletion).
 * Returns the number of tracks the owner had.
 */
export async function queueOwnerTrackAudioDeletion(
  tx: Transaction,
  args: { ownerUserId: string; reason: string; deleteAfter: Date },
): Promise<number> {
  await queueScopedTrackAudioDeletion(tx, {
    scope: eq(tracks.ownerUserId, args.ownerUserId),
    reason: args.reason,
    deleteAfter: args.deleteAfter,
  });
  const [row] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(tracks)
    .where(eq(tracks.ownerUserId, args.ownerUserId));
  return row?.value ?? 0;
}

/**
 * Batched audio queue-and-drop for a known set of tracks — the reclaim sweeps,
 * which have just tombstoned exactly these rows under their own guards.
 */
export async function queueTracksAudioDeletion(
  tx: Transaction,
  args: { trackIds: string[]; reason: string; deleteAfter: Date },
): Promise<void> {
  if (args.trackIds.length === 0) return;
  const scope = inArray(tracks.id, args.trackIds);
  await queueScopedTrackAudioDeletion(tx, {
    scope,
    reason: args.reason,
    deleteAfter: args.deleteAfter,
  });
  await severTrackAnalyticsLinks(tx, scope);
}

/** Reason recorded on a just-downloaded file whose DB asset write was declined. */
export const ORPHANED_DOWNLOAD_REASON = 'orphaned_download';

/**
 * Queue ONE just-written storage object for immediate deletion because the DB
 * declined to record it as an asset (the track stopped being downloadable while
 * the provider bytes streamed — e.g. Disliked mid-fetch — or a lock-less sibling
 * landed the asset first). Without this, the object would be orphaned: no
 * `track_audio_assets` row references it and no retention path ever queues it.
 * Runs on the caller's transaction so the queueing commits atomically with the
 * decline; the consumer's live-key guard keeps the sibling case safe (an asset
 * row referencing the same key resolves the item WITHOUT deleting).
 */
export async function queueOrphanedDownloadDeletion(
  tx: Transaction,
  args: { ownerUserId: string; trackId: string; storageKey: string; now?: Date },
): Promise<void> {
  // The decline may be a Member delete that cascaded the owner and track rows
  // away mid-fetch; referencing them would fail the FK, roll the queueing back,
  // and leave the written object with nothing that ever deletes it.
  await tx.insert(deletionQueueItems).values({
    ownerUserId: sql`(select ${user.id} from ${user} where ${user.id} = ${args.ownerUserId})`,
    trackId: sql`(select ${tracks.id} from ${tracks} where ${tracks.id} = ${args.trackId})`,
    storageKey: args.storageKey,
    reason: ORPHANED_DOWNLOAD_REASON,
    deleteAfter: args.now ?? new Date(),
  });
}

export interface DueDeletionQueueItem {
  id: string;
  /** Nullable in the schema; a keyless item has nothing to delete (mark processed). */
  storageKey: string | null;
  /**
   * True when a live `track_audio_assets` row references the same storage key
   * again — the queue item is obsolete (never delete live audio). For the
   * RETENTION reasons (reject purge, eviction) this is defense-in-depth, not a
   * race-proof guarantee (the read is a snapshot, not a lock): there the state
   * machine is what keeps a pending deletion from racing a re-landing file — a
   * deletion item only exists once its track is `rejected`/`deleted`, downloads
   * only proceed from `pending`/`streamable` (an atomic claim that observes the
   * post-commit status), `deleted` is terminal, and a re-Save regenerates a NEW
   * track whose canonical key embeds the new trackId. For `orphaned_download`
   * items this check is LOAD-BEARING, not optional: the producer queues the
   * declined key unconditionally, and when the decline was a sibling having
   * landed the asset at the same key, THIS check is what stops the consumer from
   * deleting the sibling's live file. Do not weaken or remove it.
   */
  storageKeyLive: boolean;
}

/**
 * Unprocessed items whose `deleteAfter` has passed, oldest due first — except
 * that items which already failed go after every untried one, so a full batch
 * of deletes that keep failing can never starve newer items of their turn.
 */
export async function listDueDeletionQueueItems(
  db: Database,
  args: { now?: Date; limit: number },
): Promise<DueDeletionQueueItem[]> {
  const now = args.now ?? new Date();
  return db
    .select({
      id: deletionQueueItems.id,
      storageKey: deletionQueueItems.storageKey,
      // Must stay an `exists` over a real subquery: in a join-less select,
      // Drizzle renders columns inside a raw `sql` select-field fragment
      // unqualified, which would turn this correlation into the always-true
      // self-comparison `"storage_key" = "storage_key"`.
      storageKeyLive: exists(
        db
          .select({ one: sql`1` })
          .from(trackAudioAssets)
          .where(eq(trackAudioAssets.storageKey, deletionQueueItems.storageKey)),
      ).mapWith(Boolean),
    })
    .from(deletionQueueItems)
    .where(and(isNull(deletionQueueItems.processedAt), lte(deletionQueueItems.deleteAfter, now)))
    .orderBy(
      sql`${deletionQueueItems.errorMessageSafe} is not null`,
      asc(deletionQueueItems.deleteAfter),
    )
    .limit(args.limit);
}

/**
 * Resolve a queue item: the file was deleted, there was nothing to delete, or the
 * item is permanently unactionable (`noteSafe` records why). Clears any stale
 * failure note from a previous attempt unless a new one is given. Conditional on
 * the item still being unprocessed, so an overlapping run can never re-resolve
 * (or re-stamp) an item another run already settled; returns whether THIS call
 * resolved it.
 */
export async function markDeletionQueueItemProcessed(
  db: Database,
  args: { id: string; now?: Date; noteSafe?: string },
): Promise<boolean> {
  const updated = await db
    .update(deletionQueueItems)
    .set({ processedAt: args.now ?? new Date(), errorMessageSafe: args.noteSafe ?? null })
    .where(and(eq(deletionQueueItems.id, args.id), isNull(deletionQueueItems.processedAt)))
    .returning({ id: deletionQueueItems.id });
  return updated.length > 0;
}

/**
 * Record a transient delete failure WITHOUT resolving the item — `processedAt`
 * stays null, so the next recurring run retries it. Conditional on unprocessed
 * (a failure report must never scribble over an item another run resolved);
 * returns whether the note landed.
 */
export async function recordDeletionQueueItemFailure(
  db: Database,
  args: { id: string; errorMessageSafe: string },
): Promise<boolean> {
  const updated = await db
    .update(deletionQueueItems)
    .set({ errorMessageSafe: args.errorMessageSafe })
    .where(and(eq(deletionQueueItems.id, args.id), isNull(deletionQueueItems.processedAt)))
    .returning({ id: deletionQueueItems.id });
  return updated.length > 0;
}
