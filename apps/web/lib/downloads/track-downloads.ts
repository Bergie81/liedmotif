// Server-side helpers shared by the download routes (single track, session zip,
// playlist zip): a downloaded MP3 always carries the Session's cover and
// metadata as they are RIGHT NOW, whatever the worker's asynchronous,
// best-effort retag has done with the stored file so far — it can be slow,
// backlogged, or lost. The web process composes response bytes only; the worker
// stays the only writer of tags to storage.

import type { Readable } from 'node:stream';
import { listTracksForMetadataEmbed, type Database, type DownloadableTrack } from '@liedmotif/db';
import { AlbumArtCache, loadAlbumArt, renderAlbumArt, type AlbumArtSource } from '@liedmotif/media';
import {
  assembleTrackTags,
  buildTrackTag,
  createLogger,
  mapWithConcurrency,
  LIEDMOTIF_TAG_MARKER,
  type TrackTagPlan,
} from '@liedmotif/shared';
import {
  composeId3Rewrite,
  measureStoredId3,
  readStoredObject,
  titledSegment,
  type StorageProvider,
} from '@liedmotif/storage';
import { enqueueEmbedTrackMetadataBatch } from '@/lib/worker-jobs';

const logger = createLogger({ name: 'track-downloads' });

/** One cap for the request path's existence checks. High enough to hide
 *  per-request latency, low enough that a 200-track playlist cannot burst
 *  hundreds of concurrent S3 requests. */
const STORAGE_FAN_OUT_LIMIT = 8;

export interface TrackDownloadDeps {
  db: Database;
  storage: StorageProvider;
  /** Where `APIC` renditions come from; its cache is request-scoped, so a zip
   *  renders each distinct cover once however many entries share it. */
  albumArt: AlbumArtSource;
}

/** The routes' wiring; tests build the same shape with stubs. */
export function createTrackDownloadDeps(db: Database, storage: StorageProvider): TrackDownloadDeps {
  return {
    db,
    storage,
    albumArt: {
      readCover: (key) => readStoredObject(storage, key),
      renderAlbumArt,
      artworkCache: new AlbumArtCache(),
    },
  };
}

/** One deliverable track: bytes that exist, and the tags they must carry. */
export interface TrackDownload {
  track: DownloadableTrack;
  /** The stored object's size at plan time — what a response that cannot
   *  re-measure the file reports, and never the DB's `byteSize`, which a pending
   *  retag can leave behind. */
  storedByteSize: number;
  /** The tags this track's file should carry; null when nothing about it is
   *  taggable (a non-MP3 final, or no tag context at all). */
  tags: TrackTagPlan | null;
}

/** The safe download filename `<title-slug>-<id8>.<ext>`, rebuilt from the
 *  CURRENT title (renames apply), extension from the stored key. ASCII by
 *  construction — no `filename*` encoding needed. */
export function trackDownloadFileName(
  track: Pick<DownloadableTrack, 'trackId' | 'title' | 'storageKey'>,
): string {
  const dot = track.storageKey.lastIndexOf('.');
  const ext = dot >= 0 ? track.storageKey.slice(dot + 1) : 'mp3';
  return `${titledSegment(track.title, 'track', track.trackId)}.${ext}`;
}

/**
 * The tracks a download can actually deliver, in the given order: one tag-context
 * read for the whole batch and a boundedly concurrent existence check per file.
 * Tracks whose bytes are gone are dropped with a warning — a zip that has started
 * streaming cannot change its status code, so skipping beats aborting
 * mid-download, and the single-track route reads an empty result as a 404.
 */
export async function planTrackDownloads(
  deps: TrackDownloadDeps,
  tracks: readonly DownloadableTrack[],
): Promise<TrackDownload[]> {
  const contexts = await listTracksForMetadataEmbed(
    deps.db,
    tracks.map((track) => track.trackId),
  );
  const contextsByTrackId = new Map(contexts.map((context) => [context.trackId, context]));
  const planned = await mapWithConcurrency(tracks, STORAGE_FAN_OUT_LIMIT, async (track) => {
    const stat = await deps.storage.stat(track.storageKey);
    if (!stat) {
      logger.warn('download entry skipped: stored bytes missing', { trackId: track.trackId });
      return null;
    }
    const context = contextsByTrackId.get(track.trackId);
    return {
      track,
      storedByteSize: stat.byteSize,
      tags: context ? assembleTrackTags(context) : null,
    };
  });
  return planned.filter((entry) => entry !== null);
}

export interface TrackDownloadBody {
  stream: Readable;
  /** Exact size of `stream`, for the single-track route's `Content-Length`. */
  byteSize: number;
}

/**
 * The bytes one planned track delivers, decided the moment it starts streaming:
 * the stored object when its leading tag already names the current tag state, a
 * freshly built tag followed by the stored audio body otherwise.
 *
 * Deciding HERE and not at plan time is what keeps a long zip honest: a retag can
 * land while earlier entries are still streaming, and it moves both the file's
 * size and the offset its audio body starts at, so a plan-time measurement would
 * slice a healed file to pieces. (The millisecond between this measurement and
 * the read is the same window the retag job itself documents.)
 *
 * Artwork is best-effort here as everywhere: when the current cover cannot be
 * read or rendered, the stored bytes stream unchanged rather than a text-only
 * tag that would strip artwork the file already carries — a download is never
 * blocked and never loses artwork because of a cover.
 */
export async function openTrackDownload(
  deps: TrackDownloadDeps,
  download: TrackDownload,
): Promise<TrackDownloadBody> {
  const { track, tags } = download;
  async function asStored(byteSize: number): Promise<TrackDownloadBody> {
    return { stream: await deps.storage.readStream(track.storageKey), byteSize };
  }
  if (!tags) return asStored(download.storedByteSize);

  const stored = await measureStoredId3(deps.storage, track.storageKey, LIEDMOTIF_TAG_MARKER).catch(
    (error: unknown) => {
      // Without a trustworthy tag length the audio body's offset would be a guess.
      logger.warn('leading tag unreadable; the stored bytes serve as they are', {
        trackId: track.trackId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    },
  );
  if (!stored) return asStored(download.storedByteSize);
  if (stored.marker === tags.marker) return asStored(stored.byteSize);

  // Never awaited, and never throws (the enqueue swallows its own failures): the
  // response is composed regardless of whether the stored file ever heals.
  void enqueueEmbedTrackMetadataBatch(deps.db, [track.trackId]);

  const artwork = tags.cover ? await loadAlbumArt(deps.albumArt, tags.cover) : null;
  if (tags.cover && !artwork) {
    logger.warn('cover artwork unavailable; serving the stored bytes', {
      trackId: track.trackId,
      coverImageId: tags.cover.coverImageId,
    });
    return asStored(stored.byteSize);
  }
  return composeId3Rewrite(deps.storage, track.storageKey, buildTrackTag(tags, artwork), stored);
}
