// `sweep-orphans` recurring job — the deletion-lifecycle safety net. The
// synchronous paths (session delete, playlist delete, the membership
// chokepoint's orphan rule) reclaim as they go; this hourly sweep catches what
// they cannot: state from before those rules existed, and anything a partial
// failure left behind. Three parts:
//
//   - orphan TRACKS (no living session edge, no membership, not disliked) go
//     through the same guarded reclaim as the chokepoint — audio rides the
//     deletion queue as usual;
//   - orphan COVERS (referenced by nothing, older than the safety margin) are
//     reclaimed bytes-first: their files (original + cached tile rendition) are
//     deleted HERE, directly — cover rows carry no reliable owner for a queue
//     item — and only covers whose bytes are gone have their rows dropped. A
//     failed byte delete leaves the row standing, so the next hourly run
//     retries it; `storage.delete` is an idempotent force-rm, so re-runs are
//     safe. A reclaimed cover's rendition is then unlinked a SECOND time, after
//     the row drop: that ordering is what closes the race against a covers
//     request rendering one right now (see the route).
//   - STAGED WRITES a killed process stranded, for adapters that have any.
//     Nothing else can reach them: they carry no key and no row.
//
// It closes by re-measuring the stored-byte total the storage quota is enforced
// against, so a reclaim this run made is already out of the figure the next
// admission check reads. That sum is row-backed: it moves with the track half,
// while cover and staged-write bytes were never counted in it.

import type { Database } from '@liedmotif/db';
import {
  coverRenditionKey,
  deleteOrphanedCoverImageRows,
  listOrphanedCoverImages,
  refreshStorageUsage,
  sweepOrphanedTracks,
} from '@liedmotif/db';
import type { StorageProvider } from '@liedmotif/storage';
import type { Task } from 'graphile-worker';

/** Per-run cap for each half; the next hourly run drains on. */
export const ORPHAN_SWEEP_BATCH_LIMIT = 200;

/**
 * How long a staged write may sit before the sweep calls it abandoned. Well past
 * any real write: the longest one the app performs is a final-audio download,
 * and the cost of guessing wrong is deleting a live download's bytes.
 */
export const INTERRUPTED_WRITE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface SweepOrphansDeps {
  db: Database;
  storage: StorageProvider;
  batchLimit?: number;
  /** Injected for deterministic age-window decisions in tests. */
  now?: Date;
}

export interface SweepOrphansResult {
  tracksReclaimed: number;
  coversReclaimed: number;
  coverByteDeleteFailures: number;
  /** Staged writes unlinked; always 0 on an adapter that stages nothing. */
  interruptedWritesReclaimed: number;
  /** The stored-byte total re-measured after this run's reclaims. */
  storageBytes: number;
}

export async function runSweepOrphans(deps: SweepOrphansDeps): Promise<SweepOrphansResult> {
  const limit = deps.batchLimit ?? ORPHAN_SWEEP_BATCH_LIMIT;
  const now = deps.now ?? new Date();
  const { evictedTrackIds } = await sweepOrphanedTracks(deps.db, { limit, now });

  const candidates = await listOrphanedCoverImages(deps.db, { limit, now });
  let coverByteDeleteFailures = 0;
  const byteReclaimedCoverIds: string[] = [];
  for (const cover of candidates) {
    try {
      await deps.storage.delete(cover.storageKey);
      await deps.storage.delete(coverRenditionKey(cover.coverImageId));
      byteReclaimedCoverIds.push(cover.coverImageId);
    } catch {
      // Never echo the raw error (it can carry filesystem paths); the count is
      // the operator signal. The row stays, so the next run retries the file.
      coverByteDeleteFailures += 1;
    }
  }
  const reclaimedCovers = await deleteOrphanedCoverImageRows(deps.db, {
    coverImageIds: byteReclaimedCoverIds,
    now,
  });
  // The rendition again, now that the row is gone. A covers request that was
  // rendering one through the delete above has written it by now, or will find
  // no row and drop it itself; between the two there is no gap left. Nothing is
  // accounted here — the delete above already answered for these bytes.
  for (const cover of reclaimedCovers) {
    await deps.storage.delete(coverRenditionKey(cover.coverImageId)).catch(() => undefined);
  }

  const stagedWriteCutoff = new Date(now.getTime() - INTERRUPTED_WRITE_MIN_AGE_MS);
  const interruptedWritesReclaimed =
    (await deps.storage.sweepInterruptedWrites?.(stagedWriteCutoff)) ?? 0;

  // The one place the storage quota's figure is refreshed on a schedule; the
  // admission checks only ever read it.
  const { totalBytes } = await refreshStorageUsage(deps.db, now);

  return {
    tracksReclaimed: evictedTrackIds.length,
    coversReclaimed: reclaimedCovers.length,
    coverByteDeleteFailures,
    interruptedWritesReclaimed,
    storageBytes: totalBytes,
  };
}

/** Bind to Graphile (recurring via `RECURRING_CRONTAB`). */
export function createSweepOrphansTask(deps: { db: Database; storage: StorageProvider }): Task {
  return async (_payload, helpers) => {
    const result = await runSweepOrphans({ db: deps.db, storage: deps.storage });
    if (
      result.tracksReclaimed ||
      result.coversReclaimed ||
      result.coverByteDeleteFailures ||
      result.interruptedWritesReclaimed
    ) {
      helpers.logger.info(
        `sweep-orphans reclaimed tracks=${result.tracksReclaimed} covers=${result.coversReclaimed} staged=${result.interruptedWritesReclaimed} byteFailures=${result.coverByteDeleteFailures}`,
      );
    }
  };
}
