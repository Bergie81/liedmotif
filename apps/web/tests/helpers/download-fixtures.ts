// Fixtures for the download tests: what an up-to-date stored MP3 looks like on
// disk (the exact bytes the worker's `embed-track-metadata` job would have
// written for a track's CURRENT tags), and how a Session Cover gets applied
// without a worker running. Tests seed with these to exercise the fast path,
// and compare against them to assert a composed response carries current truth.

import { eq } from 'drizzle-orm';
import {
  activitySessions,
  coverImages,
  getTrackForMetadataEmbed,
  type Database,
} from '@liedmotif/db';
import { assembleTrackTags, buildTrackTag, type Id3Artwork } from '@liedmotif/shared';
import type { StorageProvider } from '@liedmotif/storage';

/**
 * The track ids each heal enqueue was asked for, in call order. Assert through
 * this rather than `toHaveBeenCalledWith(db, ids)`: a failed deep-equal against a
 * Drizzle database exhausts the heap building its diff, so a simple mismatch
 * turns into an out-of-memory crash instead of a readable failure.
 */
export function healEnqueueTrackIds(enqueue: {
  mock: { calls: [unknown, string[]][] };
}): string[][] {
  return enqueue.mock.calls.map(([, trackIds]) => trackIds);
}

/** The leading tag a track's current context assembles to. */
export async function currentTrackTag(
  db: Database,
  trackId: string,
  artwork: Id3Artwork | null = null,
): Promise<Buffer> {
  const context = (await getTrackForMetadataEmbed(db, trackId))!;
  return Buffer.from(buildTrackTag(assembleTrackTags(context), artwork));
}

/** That tag followed by `audio` — a stored final with nothing left to retag. */
export async function currentlyTaggedFile(
  db: Database,
  trackId: string,
  audio: Uint8Array,
  artwork: Id3Artwork | null = null,
): Promise<Buffer> {
  return Buffer.concat([await currentTrackTag(db, trackId, artwork), Buffer.from(audio)]);
}

/**
 * Apply a Session Cover the way the cover `select` route does: store the image,
 * swap the Session's pointer, and leave the files' retag to the (here, absent)
 * worker. The row is marked `branded` so the album-art rendition passes a
 * `.jpg` into `APIC` verbatim (an unbranded cover would be decoded and badge-
 * composited, which needs a real image) and a composed response's artwork
 * bytes are exactly `bytes`.
 */
export async function applySessionCover(
  db: Database,
  storage: Pick<StorageProvider, 'write'>,
  args: { sessionId: string; key: string; bytes: Uint8Array },
): Promise<string> {
  await storage.write({ key: args.key, body: Buffer.from(args.bytes) });
  const [cover] = await db
    .insert(coverImages)
    .values({
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: args.key,
      branded: true,
    })
    .returning({ id: coverImages.id });
  await db
    .update(activitySessions)
    .set({ coverImageId: cover!.id })
    .where(eq(activitySessions.id, args.sessionId));
  return cover!.id;
}
