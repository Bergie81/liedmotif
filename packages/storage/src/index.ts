// Storage abstraction for Liedmotif.
//
// Application data addresses objects by key (never by hardcoded filesystem
// path). Two adapters implement the interface: `localFsStorageProvider`, which
// confines every object to the `/data` volume root, and `s3StorageProvider`
// for any S3-compatible bucket. The key layout is identical across adapters,
// so a straight `/data` → bucket sync is a valid migration.

import type { Readable } from 'node:stream';
import { slugify } from '@liedmotif/shared';
import { contentTypeForKey } from './content-type';
import { normalizeExtension } from './extension';
import { assertSafeKey } from './safe-key';

/** Drain a `readStream` result into one buffer (covers, references, MP3 retagging). */
export async function readAllBytes(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** A whole stored object plus the media type its key implies — what an image
 *  pipeline needs from storage without knowing anything about storage. */
export async function readStoredObject(
  storage: Pick<StorageProvider, 'readStream'>,
  key: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  return {
    bytes: await readAllBytes(await storage.readStream(key)),
    mediaType: contentTypeForKey(key),
  };
}

export type StorageProviderKey = 'local-fs' | 's3';

export interface StorageObjectStat {
  key: string;
  byteSize: number;
  mimeType?: string;
  updatedAt: Date;
}

export interface WriteObjectInput {
  key: string;
  /**
   * Object bytes. A web `ReadableStream` (e.g. `fetch().body`) must be converted
   * by the caller with `Readable.fromWeb(...)` before being passed here.
   */
  body: Readable | Buffer | Uint8Array;
  mimeType?: string;
}

/** Inclusive byte range for partial reads (HTTP Range / scrubbing, S3 ranged GET). */
export interface ReadStreamOptions {
  start?: number;
  end?: number;
}

/** A ranged read paired with the stat of the WHOLE object it came from. */
export interface StorageObjectWithStream {
  stream: Readable;
  /** Describes the full object: `byteSize` is the total, not the range length. */
  stat: StorageObjectStat;
}

/**
 * Vendor-neutral object storage. Audio and covers are addressed by storage key;
 * `local-fs` (the default, under `DATA_DIR`) and `s3` implement identical
 * contract semantics, encoded by the shared adapter contract test suite.
 */
export interface StorageProvider {
  readonly providerKey: StorageProviderKey;
  write(input: WriteObjectInput): Promise<StorageObjectStat>;
  /** Read an object, optionally a byte range (for Range responses / seeking). */
  readStream(key: string, options?: ReadStreamOptions): Promise<Readable>;
  /**
   * OPTIONAL combined read+stat in one storage round trip (S3: a single ranged
   * GET; local-fs: one open+fstat on the same handle) — halves the cost of every
   * Range request on the audio route. Returns null for a missing key; range
   * semantics match `readStream` (a start at/past the object size yields an
   * empty stream). Callers fall back to `stat`+`readStream` when absent, so
   * third-party implementations aren't forced. Results must never be cached:
   * ID3 retag rewrites bytes under a stable key.
   */
  readStreamWithStat?(
    key: string,
    options?: ReadStreamOptions,
  ): Promise<StorageObjectWithStream | null>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<StorageObjectStat | null>;
  /** App-routed (never provider-direct) read URL for the browser. */
  createReadUrl(key: string): Promise<string>;
  /**
   * OPTIONAL free space on the backing volume, in bytes. Only a local filesystem
   * has one; object storage answers by not implementing this at all, which is
   * how a caller tells "plenty of room" from "no such question" (see
   * `hasStorageHeadroom`). Never cache the result — a disk fills between calls,
   * and a remembered figure is exactly the one that would let it.
   */
  freeBytes?(): Promise<number>;
  /**
   * OPTIONAL reclamation of the debris an interrupted write leaves behind,
   * removing what was staged before `olderThan` and answering how many objects
   * went. Only an adapter that stages writes somewhere addressable has any —
   * a killed process cannot run its own cleanup, and the staged bytes carry no
   * key, so nothing else can ever name them. Absent on S3: a multipart upload
   * (bodies over its 8 MB part size) interrupted by a killed process leaves its
   * uploaded parts in the bucket, and this interface does not reclaim them.
   */
  sweepInterruptedWrites?(olderThan: Date): Promise<number>;
}

/** The 8-char id suffix `titledSegment` builds with — what keeps every titled
 *  segment unique even when its slug is empty or duplicated. */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/** A human-browsable, unique path segment: `<title-slug>-<short-id>` (the slug may
 *  be empty — a Session/Track title is cosmetic and nullable — so the id suffix
 *  alone still keeps the segment non-empty, safe, and unique enough on one disk).
 *  Also the download-filename idiom: ASCII-safe by construction, so a
 *  `Content-Disposition: attachment; filename="…"` needs no `filename*` encoding. */
export function titledSegment(
  title: string | null | undefined,
  fallback: string,
  id: string,
): string {
  return `${slugify(title ?? '') || fallback}-${shortId(id)}`;
}

/**
 * Canonical storage-key layout. Keeping these in one place stops application
 * data from embedding raw paths and keeps the layout consistent across adapters.
 * Each builder runs its result through `assertSafeKey`, so a malicious id (e.g. a
 * `..` segment in an ownerUserId) can never compose into a traversal key.
 */
export const storageKeys = {
  /** A session's on-disk audio folder segment, `<title-slug>-<id8>`. Computed
   *  once and PERSISTED at the session's first download (the frozen segment then
   *  rides `trackOriginal`), so a later Rename never splits the folder. */
  sessionAudioFolder(session: { id: string; title: string | null }): string {
    return titledSegment(session.title, 'session', session.id);
  },
  /**
   * `tracks/<owner>/<session-folder>/<track-title>-<id8>.<ext>` — a session's
   * tracks share one folder so the on-disk library is browsable. The folder is
   * the session's FROZEN `sessionAudioFolder` segment (claimed at its first
   * download); null = a track that outlived its session row, landing in
   * `unsorted/`. The track slug still captures the title at download time —
   * the durable identity is the id suffix, and every written key is persisted
   * on the asset row, so reads never recompute a key. Browsability is
   * best-effort naming, not an invariant.
   */
  trackOriginal(
    ownerUserId: string,
    sessionFolder: string | null,
    track: { id: string; title: string | null },
    ext: string,
  ): string {
    const file = titledSegment(track.title, 'track', track.id);
    return assertSafeKey(
      `tracks/${ownerUserId}/${sessionFolder ?? 'unsorted'}/${file}.${normalizeExtension(ext)}`,
    );
  },
  uploadedCover(ownerUserId: string, coverId: string, ext: string): string {
    return assertSafeKey(`covers/uploaded/${ownerUserId}/${coverId}.${normalizeExtension(ext)}`);
  },
  /** A generated Session Cover, grouped per owner and session. */
  generatedCover(
    ownerUserId: string,
    activitySessionId: string,
    coverId: string,
    ext: string,
  ): string {
    return assertSafeKey(
      `covers/generated/${ownerUserId}/${activitySessionId}/${coverId}.${normalizeExtension(ext)}`,
    );
  },
  /** A generated Playlist cover, grouped per owner and playlist. */
  generatedPlaylistCover(
    ownerUserId: string,
    playlistId: string,
    coverId: string,
    ext: string,
  ): string {
    return assertSafeKey(
      `covers/generated-playlists/${ownerUserId}/${playlistId}/${coverId}.${normalizeExtension(ext)}`,
    );
  },
  /** The owner's processed profile avatar; a fresh avatarId per upload keeps URLs immutable. */
  avatar(ownerUserId: string, avatarId: string, ext: string): string {
    return assertSafeKey(`avatars/${ownerUserId}/${avatarId}.${normalizeExtension(ext)}`);
  },
  /** A private voice recording (sensitive personal data — served only through
   *  owner-authorized app routes; a fresh recordingId per upload keeps keys unique). */
  voiceRecording(ownerUserId: string, recordingId: string, ext: string): string {
    return assertSafeKey(`voice/${ownerUserId}/${recordingId}.${normalizeExtension(ext)}`);
  },
  /** A processed private photo belonging to one owner-scoped Person. */
  personReferencePhoto(
    ownerUserId: string,
    personId: string,
    photoId: string,
    ext: string,
  ): string {
    return assertSafeKey(
      `person-references/${ownerUserId}/${personId}/${photoId}.${normalizeExtension(ext)}`,
    );
  },
  exportBundle(ownerUserId: string, bundleId: string): string {
    return assertSafeKey(`exports/${ownerUserId}/${bundleId}.zip`);
  },
  importBatch(ownerUserId: string, importBatchId: string): string {
    return assertSafeKey(`imports/${ownerUserId}/${importBatchId}.json`);
  },
} as const;

export { normalizeExtension } from './extension';
export {
  audioContentType,
  contentTypeForKey,
  extensionForContentType,
  DEFAULT_CONTENT_TYPE,
} from './content-type';
export { assertSafeKey, resolveObjectPath, StorageKeyError } from './safe-key';
export { localFsStorageProvider, type LocalFsStorageOptions } from './local-fs';
export { s3StorageProvider, type S3StorageOptions } from './s3';
export {
  assertStorageRootWritable,
  buildStorageProvider,
  resolveStorageRuntimeConfig,
  type LocalFsRuntimeConfig,
  type S3RuntimeConfig,
  type StorageRuntimeConfig,
} from './build';
export { hasStorageHeadroom, STORAGE_HEADROOM_MARGIN_BYTES } from './headroom';
export { createMockStorageProvider, type MockStorage } from './mock';
export { composeId3Rewrite, measureStoredId3, type StoredId3State } from './id3-probe';
