import type { Database } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import type { StorageProvider } from '@liedmotif/storage';
import type { GeneratedImageProvider } from '@liedmotif/providers';
import type { Task } from 'graphile-worker';
import { createPlaylistCoverGenerator } from '../session-cover/playlist-cover-regeneration';

interface GeneratePlaylistCoverPayload {
  playlistId: string;
  ownerUserId: string;
  /** The reserved user-regeneration attempt to drive (the only playlist flow). */
  coverGenerationId: string;
}

function parsePayload(payload: unknown): GeneratePlaylistCoverPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid generate-playlist-cover job payload.');
  }
  const candidate = payload as Record<string, unknown>;
  const playlistId = uuidSchema.safeParse(candidate.playlistId);
  const coverGenerationId = uuidSchema.safeParse(candidate.coverGenerationId);
  const ownerUserId = candidate.ownerUserId;
  if (
    !playlistId.success ||
    !coverGenerationId.success ||
    typeof ownerUserId !== 'string' ||
    ownerUserId.length === 0 ||
    ownerUserId.length > 255
  ) {
    throw new Error('Invalid generate-playlist-cover job payload.');
  }
  return {
    playlistId: playlistId.data,
    ownerUserId,
    coverGenerationId: coverGenerationId.data,
  };
}

export function createGeneratePlaylistCoverTask(deps: {
  db: Database;
  /** Prompt-driven image provider only — a Playlist cover never derives from a music task. */
  getCoverArt: () => Promise<GeneratedImageProvider | null>;
  storage: StorageProvider;
}): Task {
  return async (payload, helpers) => {
    const jobPayload = parsePayload(payload);
    const generator = createPlaylistCoverGenerator({
      db: deps.db,
      ownerUserId: jobPayload.ownerUserId,
      imageProvider: await deps.getCoverArt(),
      storage: deps.storage,
      logger: {
        info: (message, fields) => helpers.logger.info(message, fields),
        warn: (message, fields) => helpers.logger.warn(message, fields),
      },
      clock: { now: () => new Date() },
    });
    await generator.processRegeneration(jobPayload.playlistId, jobPayload.coverGenerationId);
  };
}
