import { getSessionById, type Database } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import type { StorageProvider } from '@liedmotif/storage';
import type { Task } from 'graphile-worker';
import {
  resolveSessionCoverImageProvider,
  textLlmConfigured,
  type SessionCoverProviders,
} from '../session-cover/cover-image-provider';
import {
  createSessionCoverGenerator,
  SessionCoverRetryableError,
} from '../session-cover/session-cover-generator';
import { enqueueEmbedTrackMetadata } from './enqueue';

interface GenerateSessionCoverPayload {
  activitySessionId: string;
  ownerUserId: string;
  /** A specific user-regeneration attempt to drive; absent for the initial cover. */
  coverGenerationId?: string;
}

function parsePayload(payload: unknown): GenerateSessionCoverPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid generate-session-cover job payload.');
  }
  const candidate = payload as Record<string, unknown>;
  const activitySessionId = uuidSchema.safeParse(candidate.activitySessionId);
  const ownerUserId = candidate.ownerUserId;
  const coverGenerationId =
    candidate.coverGenerationId === undefined
      ? undefined
      : uuidSchema.safeParse(candidate.coverGenerationId);
  if (
    !activitySessionId.success ||
    typeof ownerUserId !== 'string' ||
    ownerUserId.length === 0 ||
    ownerUserId.length > 255 ||
    (coverGenerationId !== undefined && !coverGenerationId.success)
  ) {
    throw new Error('Invalid generate-session-cover job payload.');
  }
  return {
    activitySessionId: activitySessionId.data,
    ownerUserId,
    ...(coverGenerationId ? { coverGenerationId: coverGenerationId.data } : {}),
  };
}

export function createGenerateSessionCoverTask(
  deps: SessionCoverProviders & {
    db: Database;
    storage: StorageProvider;
  },
): Task {
  return async (payload, helpers) => {
    const jobPayload = parsePayload(payload);
    // User regenerations are always prompt-driven (session: null); the initial
    // cover honors the session's cover-source choice. A missing session resolves
    // like prompt-driven and the generator then reports it missing — but a
    // FAILED read retries: guessing the source could style a standard session.
    const session = jobPayload.coverGenerationId
      ? null
      : await getSessionById(deps.db, {
          ownerUserId: jobPayload.ownerUserId,
          sessionId: jobPayload.activitySessionId,
        }).catch(() => {
          throw new SessionCoverRetryableError();
        });
    const generator = createSessionCoverGenerator({
      db: deps.db,
      ownerUserId: jobPayload.ownerUserId,
      imageProvider: await resolveSessionCoverImageProvider(deps.db, deps, session),
      storage: deps.storage,
      metadataQueue: {
        enqueue: (trackId) => enqueueEmbedTrackMetadata(helpers.addJob, trackId),
      },
      logger: {
        info: (message, fields) => helpers.logger.info(message, fields),
        warn: (message, fields) => helpers.logger.warn(message, fields),
      },
      clock: { now: () => new Date() },
      textLlmConfigured: await textLlmConfigured(deps.getLlm),
    });
    if (jobPayload.coverGenerationId) {
      await generator.processRegeneration(
        jobPayload.activitySessionId,
        jobPayload.coverGenerationId,
      );
    } else {
      await generator.ensureGenerated(jobPayload.activitySessionId);
    }
  };
}
