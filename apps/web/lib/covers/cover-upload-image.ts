// Server-side processing for an uploaded custom cover, shared by the Playlist
// and Session cover upload routes. The RAW upload is never stored: it runs
// through the same normalization the generated pipeline applies (square, WebP,
// one quality constant) — dropping ALL metadata (EXIF/GPS/ICC), the same privacy
// posture as the avatar pipeline. Uploaded covers are cosmetic artwork only and
// never feed cover generation.

import { randomUUID } from 'node:crypto';
import { normalizeCoverImageToWebp } from '@liedmotif/media';
import { storageKeys } from '@liedmotif/storage';
import { withUploadDecodeSlot } from '@/lib/media/image-decode-slots';
import { getStorageProvider } from '@/lib/providers/providers';
import type { RecordStoredBytes } from '@/lib/media/storage-quota';

export interface ProcessedCoverImage {
  bytes: Uint8Array;
  mediaType: 'image/webp';
}

/**
 * Re-encode an upload as a square, metadata-free WebP cover. Returns null when
 * the bytes are not a decodable image or exceed the decode ceiling (the route
 * maps either to a validation error). Stored covers are always clean — the
 * Liedmotif badge exists only in embedded album art.
 */
export async function processCoverUpload(input: Uint8Array): Promise<ProcessedCoverImage | null> {
  try {
    // The decode of the UNTRUSTED upload takes a slot.
    const bytes = await withUploadDecodeSlot(() => normalizeCoverImageToWebp(input));
    return { bytes, mediaType: 'image/webp' };
  } catch {
    return null;
  }
}

/**
 * Write processed cover bytes and register them, in that order, and answer with
 * the new `coverImageId` when `register` answers `kept`, or with the outcome it
 * refused with. Registration is the caller's, since Sessions and Playlists admit
 * an upload on different terms; the compensation is owned here, so a
 * registration that refuses or throws never leaves the stored object behind. A
 * registered cover reports its size to the storage admission, since only a kept
 * cover occupies the quota.
 */
export async function storeUploadedCover<Outcome extends string>(args: {
  ownerUserId: string;
  processed: ProcessedCoverImage;
  recordStored: RecordStoredBytes;
  register: (cover: {
    coverImageId: string;
    storageProvider: string;
    storageKey: string;
    byteSize: number;
  }) => Promise<Outcome>;
  /** The outcome that keeps the cover; any other deletes the written bytes. */
  kept: NoInfer<Outcome>;
}): Promise<{ coverImageId: string } | { refused: Outcome }> {
  const storage = getStorageProvider();
  const coverImageId = randomUUID();
  const storageKey = storageKeys.uploadedCover(args.ownerUserId, coverImageId, 'webp');
  const stat = await storage.write({
    key: storageKey,
    body: args.processed.bytes,
    mimeType: args.processed.mediaType,
  });

  let outcome: Outcome | null = null;
  try {
    outcome = await args.register({
      coverImageId,
      storageProvider: storage.providerKey,
      storageKey,
      byteSize: stat.byteSize,
    });
  } finally {
    if (outcome === args.kept) args.recordStored(stat.byteSize);
    else await storage.delete(storageKey).catch(() => undefined);
  }
  return outcome === args.kept ? { coverImageId } : { refused: outcome };
}
