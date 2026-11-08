// Best-effort Graphile enqueues from the web process (server-only): cosmetic
// follow-up work no sweep watches for (generated Session Covers at creation,
// MP3 retags on an Artist Name change) and the latency kick for the initial
// buffer fill the sweep WOULD deliver, just up to a minute late. The
// graphile_worker schema is installed out-of-band by the worker migrator, so a
// failed enqueue (fresh dev DB, worker never migrated) is logged and swallowed:
// nothing here may fail the user's request — every job is either cosmetic by
// contract or covered by the sweep.

import {
  addWorkerJob,
  addWorkerJobBatch,
  PLAYLIST_COVER_JOB_IDENTIFIER,
  playlistCoverJobKey,
  SESSION_BUFFER_JOB_IDENTIFIER,
  SESSION_COVER_JOB_IDENTIFIER,
  SESSION_COVER_JOB_MAX_ATTEMPTS,
  sessionBufferJobKey,
  sessionCoverJobKey,
  TRACK_EMBED_QUEUE_NAME,
  type Database,
} from '@liedmotif/db';
import { createLogger } from '@liedmotif/shared';

const logger = createLogger({ name: 'worker-jobs' });

/**
 * Enqueue `generate-session-cover`, deduped per session. Never throws; returns
 * false on failure — the session then simply keeps its placeholder cover.
 */
export async function enqueueGenerateSessionCover(
  db: Database,
  args: { activitySessionId: string; ownerUserId: string },
): Promise<boolean> {
  try {
    await addWorkerJob(
      db,
      SESSION_COVER_JOB_IDENTIFIER,
      { activitySessionId: args.activitySessionId, ownerUserId: args.ownerUserId },
      {
        jobKey: sessionCoverJobKey(args.activitySessionId),
        maxAttempts: SESSION_COVER_JOB_MAX_ATTEMPTS,
      },
    );
    return true;
  } catch (err) {
    logger.warn('could not enqueue generate-session-cover (cosmetic; placeholder cover stays)', {
      activitySessionId: args.activitySessionId,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return false;
  }
}

/**
 * Enqueue one specific user-regeneration attempt under a per-attempt job key —
 * the fixed `cover:<sessionId>` key would dedupe against the session's initial
 * cover job. Never throws; a failed enqueue leaves the reserved attempt for the
 * worker's aged-cover recovery scan.
 */
export async function enqueueRegenerateSessionCover(
  db: Database,
  args: { activitySessionId: string; ownerUserId: string; coverGenerationId: string },
): Promise<boolean> {
  try {
    await addWorkerJob(
      db,
      SESSION_COVER_JOB_IDENTIFIER,
      {
        activitySessionId: args.activitySessionId,
        ownerUserId: args.ownerUserId,
        coverGenerationId: args.coverGenerationId,
      },
      {
        jobKey: `${sessionCoverJobKey(args.activitySessionId)}:${args.coverGenerationId}`,
        maxAttempts: SESSION_COVER_JOB_MAX_ATTEMPTS,
      },
    );
    return true;
  } catch (err) {
    logger.warn('could not enqueue the cover regeneration (the recovery scan will pick it up)', {
      activitySessionId: args.activitySessionId,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return false;
  }
}

/**
 * Enqueue one reserved Playlist cover regeneration attempt under a per-attempt
 * job key (the same machinery as Session Covers). Never
 * throws; the caller reports the attempt as started either way and the ledger
 * row remains re-drivable.
 */
export async function enqueueRegeneratePlaylistCover(
  db: Database,
  args: { playlistId: string; ownerUserId: string; coverGenerationId: string },
): Promise<boolean> {
  try {
    await addWorkerJob(
      db,
      PLAYLIST_COVER_JOB_IDENTIFIER,
      {
        playlistId: args.playlistId,
        ownerUserId: args.ownerUserId,
        coverGenerationId: args.coverGenerationId,
      },
      {
        jobKey: `${playlistCoverJobKey(args.playlistId)}:${args.coverGenerationId}`,
        maxAttempts: SESSION_COVER_JOB_MAX_ATTEMPTS,
      },
    );
    return true;
  } catch (err) {
    logger.warn('could not enqueue the playlist cover regeneration', {
      playlistId: args.playlistId,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
    return false;
  }
}

/**
 * Enqueue the session's `ensure-session-buffer` fill at creation, so the first
 * provider submit does not wait for the worker's once-per-minute sweep. Same
 * job key as the sweep's enqueue — the two dedupe, and the buffer controller's
 * own per-owner locking and budget checks still decide whether anything is
 * actually submitted. Never throws: the sweep is the safety net, so a failed
 * enqueue only costs the latency win.
 */
export async function enqueueEnsureSessionBuffer(db: Database, sessionId: string): Promise<void> {
  try {
    await addWorkerJob(
      db,
      SESSION_BUFFER_JOB_IDENTIFIER,
      { sessionId },
      { jobKey: sessionBufferJobKey(sessionId) },
    );
  } catch (err) {
    logger.warn('could not enqueue ensure-session-buffer (the sweep will fill the buffer)', {
      sessionId,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/** Enqueue `embed-track-metadata` for each track, deduped per track, in ONE
 * statement — an artist rename can cover the whole library. Never throws. */
export async function enqueueEmbedTrackMetadataBatch(
  db: Database,
  trackIds: string[],
): Promise<void> {
  try {
    await addWorkerJobBatch(
      db,
      'embed-track-metadata',
      trackIds.map((trackId) => ({ payload: { trackId }, jobKey: `embed:${trackId}` })),
      TRACK_EMBED_QUEUE_NAME,
    );
  } catch (err) {
    logger.warn('could not enqueue embed-track-metadata (cosmetic; tags stay stale)', {
      trackCount: trackIds.length,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }
}
