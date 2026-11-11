// `embed-track-metadata`: write a Track's current ID3 tags (see
// `assembleTrackTags` for the frame set) into its LOCAL final MP3, so shared or
// exported files stay self-contained in external players (never into provider
// stream-proxy responses — this job only ever touches `local_original` assets).
// This job is the ONLY writer of tags to storage; the download routes compose
// current-truth responses but never rewrite a stored file.
//
// Enqueued from `download-final-audio` when a final MP3 lands,
// `generate-session-cover` when a generated cover replaces the placeholder,
// `analyze-track-bpm-key` when a BPM lands after the first embed, the lyrics
// route when the words arrive late, the profile route when the Artist Name
// changes, and the download routes when they find a file's tags stale.
// Best-effort and IDEMPOTENT: a `TXXX` marker frame records what was embedded,
// so a re-enqueue with unchanged inputs reads the file and returns without
// rewriting.
//
// The read→retag→write here is not transactional with the deletion pipeline: a
// Track deleted mid-embed can have its file re-created by the final write. The
// byte-size update afterwards finds no asset row then and queues the key for
// deletion again, so the re-created file is reclaimed.

import type { Database } from '@liedmotif/db';
import { getTrackForMetadataEmbed, updateLocalOriginalByteSize } from '@liedmotif/db';
import { AlbumArtCache, loadAlbumArt, renderAlbumArt, type AlbumArtSource } from '@liedmotif/media';
import {
  assembleTrackTags,
  buildTrackTag,
  LIEDMOTIF_TAG_MARKER,
  type LogFields,
} from '@liedmotif/shared';
import {
  composeId3Rewrite,
  measureStoredId3,
  readStoredObject,
  type StorageProvider,
} from '@liedmotif/storage';
import type { Task } from 'graphile-worker';

export interface EmbedTrackMetadataDeps {
  db: Database;
  storage: StorageProvider;
  /** Where `APIC` renditions come from; its cache lives for the worker process,
   *  so a session-wide retag renders each cover once instead of once per track. */
  albumArt: AlbumArtSource;
  warn: (message: string, fields?: LogFields) => void;
}

export interface EmbedTrackMetadataPayload {
  trackId: string;
}

/** `missing` covers everything with nothing to tag: no track row, no local MP3
 *  final, or a final whose bytes are no longer in storage. */
export type EmbedTrackMetadataOutcome = 'missing' | 'already_tagged' | 'tagged';

export interface EmbedTrackMetadataResult {
  outcome: EmbedTrackMetadataOutcome;
}

export async function runEmbedTrackMetadata(
  deps: EmbedTrackMetadataDeps,
  payload: EmbedTrackMetadataPayload,
): Promise<EmbedTrackMetadataResult> {
  // The context read inner-joins the local MP3 asset, so a missing track, a
  // non-MP3 final, or evicted audio all land here — nothing to (re)tag.
  const context = await getTrackForMetadataEmbed(deps.db, payload.trackId);
  if (!context) return { outcome: 'missing' };
  const plan = assembleTrackTags(context);

  // Marker fast path: "already tagged?" is answerable from the leading ID3 tag
  // alone (small ranged reads) — a batch retag (artist rename over the whole
  // library) must not pull every multi-MB MP3 into memory just to skip it.
  const audioKey = context.audio.storageKey;
  const stored = await measureStoredId3(deps.storage, audioKey, LIEDMOTIF_TAG_MARKER);
  if (!stored) return { outcome: 'missing' };
  if (stored.marker === plan.marker) return { outcome: 'already_tagged' };

  const artwork = plan.cover ? await loadAlbumArt(deps.albumArt, plan.cover) : null;
  if (plan.cover && !artwork) {
    // Best-effort: unreadable/unconvertible cover art never blocks the text tags.
    deps.warn('cover artwork unavailable for embed; tagging text frames only', {
      trackId: payload.trackId,
      coverImageId: plan.cover.coverImageId,
    });
  }

  // Stream `new tag ++ old audio body` straight back through the storage write
  // instead of buffering the whole MP3 twice: adapters stage the write aside
  // (local-fs: temp file + atomic rename; S3: multipart upload) and publish it
  // only on completion, so the ranged read of the old object stays consistent
  // for the entire rewrite.
  // The marker must name what is actually written: a cover-less tag carries the
  // cover-less marker, so the next embed or download retries the art instead of
  // reading the file as current.
  const written =
    plan.cover && !artwork
      ? { ...plan, marker: assembleTrackTags({ ...context, cover: null }).marker }
      : plan;
  const tag = buildTrackTag(written, artwork);
  const { stream } = composeId3Rewrite(deps.storage, audioKey, tag, stored);
  const stat = await deps.storage.write({
    key: audioKey,
    body: stream,
    mimeType: context.audio.mimeType ?? 'audio/mpeg',
  });
  await updateLocalOriginalByteSize(deps.db, {
    trackId: payload.trackId,
    storageKey: audioKey,
    byteSize: stat.byteSize,
  });
  return { outcome: 'tagged' };
}

/** Bind to Graphile, deduped per track with `embed:<trackId>` (see enqueue.ts). */
export function createEmbedTrackMetadataTask(deps: {
  db: Database;
  storage: StorageProvider;
}): Task {
  const albumArt: AlbumArtSource = {
    readCover: (key) => readStoredObject(deps.storage, key),
    renderAlbumArt,
    artworkCache: new AlbumArtCache(),
  };
  return async (payload, helpers) => {
    await runEmbedTrackMetadata(
      {
        db: deps.db,
        storage: deps.storage,
        albumArt,
        warn: (message, fields) => helpers.logger.warn(message, fields),
      },
      payload as EmbedTrackMetadataPayload,
    );
  };
}
