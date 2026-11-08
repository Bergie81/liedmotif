// `process-deletion-queue` recurring job — the consumer that closes the
// deletion loop. The producers (`rejectDislikedTrack`, `evictSessionEphemeralAudio`)
// drop the `track_audio_assets` rows and leave `deletion_queue_items.storage_key`
// as the only reference to the file; this job actually reclaims the bytes:
// due items → `storage.delete(storageKey)` → `processedAt`. Without it, a
// Dislike's "deleted after ~24h" and session deletion only ever happen in the
// database while `/data` grows unboundedly.
//
// Failure semantics per item: a transient delete error records
// `errorMessageSafe` and leaves the item unprocessed (retried by the next run);
// a permanently unactionable item (malformed key) is resolved with a note so it
// cannot poison the queue forever. The flat once-a-minute retry is deliberate —
// a failed `rm` costs microseconds and the error note is the operator signal;
// backoff/attempt metadata would need schema for a failure mode this instance
// can't meaningfully hit yet. A key that a live audio asset references AGAIN
// (audio re-landed after the deletion was queued) is never deleted — the queue
// item is obsolete, not the audio. For retention deletes that check is
// defense-in-depth (the state machine is the real guarantee), but for
// `orphaned_download` items it is LOAD-BEARING — it is what protects a sibling's
// live file at the same key (see `DueDeletionQueueItem`). Do not weaken it.

import type { Database } from '@liedmotif/db';
import {
  listDueDeletionQueueItems,
  markDeletionQueueItemProcessed,
  recordDeletionQueueItemFailure,
} from '@liedmotif/db';
import { StorageKeyError, type StorageProvider } from '@liedmotif/storage';
import type { Task } from 'graphile-worker';

/** Per-run cap; anything beyond it stays due and the next run (1 min) drains on. */
export const DELETION_QUEUE_BATCH_LIMIT = 200;

export interface ProcessDeletionQueueDeps {
  db: Database;
  storage: StorageProvider;
  batchLimit?: number;
  /** Injected for deterministic due-window/processedAt timestamps in tests. */
  now?: Date;
}

export interface ProcessDeletionQueueResult {
  deleted: number;
  skippedLiveKey: number;
  failed: number;
}

export async function runProcessDeletionQueue(
  deps: ProcessDeletionQueueDeps,
): Promise<ProcessDeletionQueueResult> {
  const now = deps.now ?? new Date();
  const due = await listDueDeletionQueueItems(deps.db, {
    now,
    limit: deps.batchLimit ?? DELETION_QUEUE_BATCH_LIMIT,
  });

  // Counters reflect state changes THIS run landed: each conditional write returns
  // false when an overlapping run already settled the item, and then it counts
  // nowhere here (the work happened, just not in this run).
  const result: ProcessDeletionQueueResult = { deleted: 0, skippedLiveKey: 0, failed: 0 };
  for (const item of due) {
    if (item.storageKey && item.storageKeyLive) {
      const settled = await markDeletionQueueItemProcessed(deps.db, {
        id: item.id,
        now,
        noteSafe: 'skipped: a live audio asset references this storage key again',
      });
      if (settled) result.skippedLiveKey += 1;
      continue;
    }
    try {
      // Keyless items have nothing to delete; `delete` itself is idempotent on a
      // missing file (`rm force`), so a crash between delete and mark re-runs safely.
      if (item.storageKey) await deps.storage.delete(item.storageKey);
      if (await markDeletionQueueItemProcessed(deps.db, { id: item.id, now })) {
        result.deleted += 1;
      }
    } catch (err) {
      const settled =
        err instanceof StorageKeyError
          ? // A key that fails validation can never succeed — resolve it with a
            // note instead of retrying forever.
            await markDeletionQueueItemProcessed(deps.db, {
              id: item.id,
              now,
              noteSafe: 'invalid storage key',
            })
          : // Never echo the raw error: it can carry filesystem paths. Left due.
            await recordDeletionQueueItemFailure(deps.db, {
              id: item.id,
              errorMessageSafe: 'storage delete failed',
            });
      if (settled) result.failed += 1;
    }
  }
  return result;
}

/** Bind to Graphile (recurring via `RECURRING_CRONTAB`). */
export function createProcessDeletionQueueTask(deps: {
  db: Database;
  storage: StorageProvider;
}): Task {
  return async () => {
    await runProcessDeletionQueue({ db: deps.db, storage: deps.storage });
  };
}
