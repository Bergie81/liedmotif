import {
  getSessionById,
  listAgedSessionCoverGenerationIds,
  type AgedSessionCoverGenerationId,
  type Database,
} from '@liedmotif/db';
import type { StorageProvider } from '@liedmotif/storage';
import type { Task } from 'graphile-worker';
import {
  resolveSessionCoverImageProvider,
  resolveTailoredCoverImageProvider,
  type SessionCoverProviders,
} from '../session-cover/cover-image-provider';
import { createPlaylistCoverGenerator } from '../session-cover/playlist-cover-regeneration';
import type { SessionCoverLogger } from '../session-cover/session-cover-attempt';
import { createSessionCoverGenerator } from '../session-cover/session-cover-generator';
import { enqueueEmbedTrackMetadata } from './enqueue';

const RECOVERY_AGE_MS = 10 * 60 * 1_000;
// Small on purpose: each recovery can be a full image-provider call (up to the
// ~120 s Suno poll ceiling), run serially inside ONE cron job that occupies one
// of the runner's few slots — batch × ceiling stays under ~4 minutes. The scan
// fires every minute, so a backlog still drains at BATCH × 1/min without ever
// pinning a slot for tens of minutes.
const RECOVERY_BATCH_SIZE = 2;

export async function scanAgedSessionCovers(deps: {
  listAged(args: { updatedBefore: Date; limit: number }): Promise<AgedSessionCoverGenerationId[]>;
  ensureGenerated(row: AgedSessionCoverGenerationId): Promise<void>;
  now: Date;
}): Promise<{ identified: number; attempted: number }> {
  const rows = await deps.listAged({
    updatedBefore: new Date(deps.now.getTime() - RECOVERY_AGE_MS),
    limit: RECOVERY_BATCH_SIZE,
  });
  for (const row of rows) {
    try {
      await deps.ensureGenerated(row);
    } catch {
      // A retryable operation remains eligible for the next bounded scan.
    }
  }
  return { identified: rows.length, attempted: rows.length };
}

export function createRecoverSessionCoversTask(
  deps: SessionCoverProviders & {
    db: Database;
    storage: StorageProvider;
  },
): Task {
  return async (_payload, helpers) => {
    const now = new Date();
    await scanAgedSessionCovers({
      now,
      listAged: (args) => listAgedSessionCoverGenerationIds(deps.db, args),
      ensureGenerated: async ({ id, ownerUserId, activitySessionId, playlistId, trigger }) => {
        const logger: SessionCoverLogger = {
          info: (message, fields) => helpers.logger.info(message, fields),
          warn: (message, fields) => helpers.logger.warn(message, fields),
        };
        if (playlistId) {
          // When a Playlist attempt's own job never ran or gave up, nothing but
          // this scan settles it, and the live-unique index would block the
          // Playlist's next regeneration for good.
          await createPlaylistCoverGenerator({
            db: deps.db,
            ownerUserId,
            imageProvider: await resolveTailoredCoverImageProvider(deps.db, deps.getCoverArt),
            storage: deps.storage,
            logger,
            clock: { now: () => now },
          }).processRegeneration(playlistId, id);
          return;
        }
        if (!activitySessionId) return;
        // Per-session provider resolution mirroring the generate-session-cover
        // task: an aged regeneration stays prompt-driven; the initial cover
        // honors the session's cover-source choice.
        const session =
          trigger === 'user_regenerate'
            ? null
            : await getSessionById(deps.db, {
                ownerUserId,
                sessionId: activitySessionId,
              });
        const generator = createSessionCoverGenerator({
          db: deps.db,
          ownerUserId,
          imageProvider: await resolveSessionCoverImageProvider(deps.db, deps, session),
          storage: deps.storage,
          metadataQueue: {
            enqueue: (trackId) => enqueueEmbedTrackMetadata(helpers.addJob, trackId),
          },
          logger,
          clock: { now: () => now },
        });
        if (trigger === 'user_regenerate') {
          await generator.processRegeneration(activitySessionId, id);
        } else {
          await generator.ensureGenerated(activitySessionId);
        }
      },
    });
  };
}
