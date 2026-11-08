import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessions,
  coverImages,
  getOwnedDownloadableTrack,
  getTrackForMetadataEmbed,
  type DownloadableTrack,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { AlbumArtCache, type RenderAlbumArt } from '@liedmotif/media';
import { readId3Tags, stripId3v2 } from '@liedmotif/shared';
import {
  createMockStorageProvider,
  readAllBytes,
  readStoredObject,
  type MockStorage,
} from '@liedmotif/storage';
import {
  applySessionCover,
  currentTrackTag,
  currentlyTaggedFile,
  healEnqueueTrackIds,
} from '../helpers/download-fixtures';

// The download composition seam: a download carries the Session's tags as they
// are RIGHT NOW, whatever the (asynchronous, best-effort) worker retag has done
// with the stored file so far.

const enqueueEmbedTrackMetadataBatch = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _trackIds: string[]) => undefined),
);
vi.mock('@/lib/worker-jobs', () => ({ enqueueEmbedTrackMetadataBatch }));

const { openTrackDownload, planTrackDownloads } = await import('@/lib/track-downloads');
type TrackDownloadDeps = Parameters<typeof planTrackDownloads>[0];

const skip = !TEST_DATABASE_URL;
const FIXTURE_TABLES = [...GENERATION_FIXTURE_TABLES, 'cover_images'] as const;

/** A fake MP3 body (frame sync + junk) so we can assert audio frames survive. */
const AUDIO = new Uint8Array([0xff, 0xfb, ...Array.from({ length: 48 }, (_, i) => i)]);
const JPEG_ART = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6]);

let testDb: TestDb;
let store: MockStorage;
let renderCount = 0;

const stubRender: RenderAlbumArt = async () => {
  renderCount += 1;
  return { mediaType: 'image/jpeg', bytes: JPEG_ART };
};

function deps(renderAlbumArt: RenderAlbumArt = stubRender): TrackDownloadDeps {
  return {
    db: testDb.db,
    storage: store.provider,
    albumArt: {
      readCover: (key) => readStoredObject(store.provider, key),
      renderAlbumArt,
      artworkCache: new AlbumArtCache(),
    },
  };
}

interface Seeded {
  ownerUserId: string;
  sessionId: string;
  trackId: string;
  key: string;
}

let keyCounter = 0;

/** Apply a fresh Session Cover; `.webp` bytes go through the album-art render. */
function applyCover(sessionId: string): Promise<string> {
  keyCounter += 1;
  return applySessionCover(testDb.db, store.provider, {
    sessionId,
    key: `covers/fixture-${keyCounter}.webp`,
    bytes: new Uint8Array([9, 9, 9]),
  });
}

async function seedTrack(
  options: {
    ownerUserId?: string;
    sessionId?: string;
    title?: string;
    ext?: string;
    withCover?: boolean;
  } = {},
): Promise<Seeded> {
  keyCounter += 1;
  const ownerUserId = options.ownerUserId ?? (await createUser(testDb.db));
  const sessionId = options.sessionId ?? (await createSession(testDb.db, { ownerUserId }));
  if (options.withCover) await applyCover(sessionId);
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  const ext = options.ext ?? 'mp3';
  const key = `tracks/${ownerUserId}/fixture/track-${keyCounter}.${ext}`;
  const trackId = await createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: options.title ?? 'Morning Haze',
    audioStorageKey: key,
    audioMimeType: ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`,
  });
  return { ownerUserId, sessionId, trackId, key };
}

/** Store the file the worker WOULD have written for this track's current tags. */
async function storeCurrentlyTaggedFile(seeded: Seeded): Promise<Uint8Array> {
  const hasCover = (await getTrackForMetadataEmbed(testDb.db, seeded.trackId))!.cover !== null;
  const body = await currentlyTaggedFile(
    testDb.db,
    seeded.trackId,
    AUDIO,
    hasCover ? { mediaType: 'image/jpeg', bytes: JPEG_ART } : null,
  );
  await store.provider.write({ key: seeded.key, body, mimeType: 'audio/mpeg' });
  return new Uint8Array(body);
}

async function storeBytes(seeded: Seeded, body: Uint8Array): Promise<void> {
  await store.provider.write({ key: seeded.key, body, mimeType: 'audio/mpeg' });
}

async function downloadable(seeded: Seeded): Promise<DownloadableTrack> {
  const track = await getOwnedDownloadableTrack(testDb.db, {
    ownerUserId: seeded.ownerUserId,
    trackId: seeded.trackId,
  });
  return track!;
}

/** The bytes a download would deliver, plus the size its Content-Length claims. */
async function download(
  seeded: Seeded,
  renderAlbumArt?: RenderAlbumArt,
): Promise<{ bytes: Uint8Array; byteSize: number }> {
  const shared = deps(renderAlbumArt);
  const [planned] = await planTrackDownloads(shared, [await downloadable(seeded)]);
  const body = await openTrackDownload(shared, planned!);
  return { bytes: await readAllBytes(body.stream), byteSize: body.byteSize };
}

/** The bytes several tracks deliver within ONE request — one plan, one cache. */
async function downloadAll(seeds: Seeded[]): Promise<Uint8Array[]> {
  const shared = deps();
  const planned = await planTrackDownloads(shared, await Promise.all(seeds.map(downloadable)));
  const served: Uint8Array[] = [];
  for (const entry of planned) {
    served.push(await readAllBytes((await openTrackDownload(shared, entry)).stream));
  }
  return served;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('track-downloads-test');
  store = createMockStorageProvider();
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb?.pool.end();
  await store?.cleanup();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, FIXTURE_TABLES);
  enqueueEmbedTrackMetadataBatch.mockClear();
  renderCount = 0;
});

describe.skipIf(skip)('current-truth track downloads', () => {
  it('streams the stored bytes untouched when their tags are already current', async () => {
    const seeded = await seedTrack({ withCover: true });
    const stored = await storeCurrentlyTaggedFile(seeded);

    const served = await download(seeded);
    expect(served.bytes).toEqual(stored);
    expect(served.byteSize).toBe(stored.length);
    expect(renderCount).toBe(0);
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([]);
  });

  it('composes the current cover for a file the worker has not retagged yet', async () => {
    const seeded = await seedTrack({ withCover: true });
    await storeCurrentlyTaggedFile(seeded);
    // The owner applies a different Session Cover; no worker is running.
    await applyCover(seeded.sessionId);

    const served = await download(seeded);
    const expected = await currentlyTaggedFile(testDb.db, seeded.trackId, AUDIO, {
      mediaType: 'image/jpeg',
      bytes: JPEG_ART,
    });
    expect(Buffer.from(served.bytes)).toEqual(expected);
    expect(stripId3v2(served.bytes)).toEqual(AUDIO);
    expect(served.byteSize).toBe(served.bytes.length);
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([[seeded.trackId]]);
  });

  it("hands the cover's stored brandedness from the database to the rendition", async () => {
    const seeded = await seedTrack({ withCover: true });
    await storeBytes(seeded, AUDIO);

    const brandedFlags: boolean[] = [];
    const capture: RenderAlbumArt = async (_bytes, _mediaType, branded) => {
      brandedFlags.push(branded);
      return { mediaType: 'image/jpeg', bytes: JPEG_ART };
    };
    // A fresh cover row stores clean bytes; a legacy row already carries the
    // badge — the compose path must tell the rendition which it is serving, so
    // drive the column here rather than inherit whatever the fixture seeds.
    await testDb.db.update(coverImages).set({ branded: false });
    await download(seeded, capture);
    await testDb.db.update(coverImages).set({ branded: true });
    await download(seeded, capture);
    expect(brandedFlags).toEqual([false, true]);
  });

  it('composes current text frames for a file that carries no tag at all', async () => {
    const seeded = await seedTrack({ title: 'Untagged' });
    await testDb.db
      .update(activitySessions)
      .set({ title: 'Evening Jazz' })
      .where(eq(activitySessions.id, seeded.sessionId));
    await storeBytes(seeded, AUDIO);

    const served = await download(seeded);
    const parsed = readId3Tags(served.bytes)!;
    expect(parsed.title).toBe('Untagged');
    expect(parsed.album).toBe('Evening Jazz');
    expect(parsed.hasArtwork).toBe(false);
    expect(stripId3v2(served.bytes)).toEqual(AUDIO);
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([[seeded.trackId]]);
  });

  it('serves the fresh tag alone when the stored tag claims the whole file', async () => {
    const seeded = await seedTrack();
    // An ID3 header whose declared size runs past EOF: there is no audio body to
    // append, so the composition must not read past the end of the object.
    const corrupt = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x7f, 0x7f, 1, 2, 3]);
    await storeBytes(seeded, corrupt);

    const served = await download(seeded);
    expect(Buffer.from(served.bytes)).toEqual(await currentTrackTag(testDb.db, seeded.trackId));
    expect(served.byteSize).toBe(served.bytes.length);
  });

  it('falls back to the stored bytes when the current cover cannot be rendered', async () => {
    const seeded = await seedTrack({ withCover: true });
    const stored = await storeCurrentlyTaggedFile(seeded);
    await applyCover(seeded.sessionId);

    const served = await download(seeded, async () => null);
    expect(served.bytes).toEqual(stored);
    expect(served.byteSize).toBe(stored.length);
    // The stored file is still stale, so the heal still gets enqueued.
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([[seeded.trackId]]);
  });

  it('passes a non-MP3 final through untouched and never enqueues a retag', async () => {
    const seeded = await seedTrack({ ext: 'wav' });
    await storeBytes(seeded, AUDIO);

    const served = await download(seeded);
    expect(served.bytes).toEqual(AUDIO);
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([]);
  });

  it('renders one shared cover once across a multi-track request', async () => {
    const first = await seedTrack({ withCover: true });
    const second = await seedTrack({
      ownerUserId: first.ownerUserId,
      sessionId: first.sessionId,
      title: 'Second',
    });
    await storeBytes(first, AUDIO);
    await storeBytes(second, AUDIO);

    const served = await downloadAll([first, second]);
    expect(served).toHaveLength(2);
    expect(renderCount).toBe(1);
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([
      [first.trackId],
      [second.trackId],
    ]);
  });

  it("gives every track its own Session's cover in one request", async () => {
    const first = await seedTrack({ withCover: true, title: 'First' });
    const second = await seedTrack({ withCover: true, title: 'Second' });
    await storeBytes(first, AUDIO);
    await storeBytes(second, AUDIO);

    const served = await downloadAll([first, second]);

    // Two Sessions, two covers: neither track may inherit the other's artwork,
    // and the memo is per cover image, so both are rendered.
    expect(renderCount).toBe(2);
    const artwork = { mediaType: 'image/jpeg' as const, bytes: JPEG_ART };
    expect(served.map(Buffer.from)).toEqual([
      await currentlyTaggedFile(testDb.db, first.trackId, AUDIO, artwork),
      await currentlyTaggedFile(testDb.db, second.trackId, AUDIO, artwork),
    ]);
  });

  it('re-reads the stored tag at stream time, so a retag landing first cannot mis-slice it', async () => {
    const seeded = await seedTrack({ withCover: true });
    await storeBytes(seeded, AUDIO);

    const shared = deps();
    const [planned] = await planTrackDownloads(shared, [await downloadable(seeded)]);
    // The heal this download enqueued lands before the entry starts streaming.
    const healed = await storeCurrentlyTaggedFile(seeded);

    const body = await openTrackDownload(shared, planned!);
    expect(await readAllBytes(body.stream)).toEqual(healed);
    expect(body.byteSize).toBe(healed.length);
  });

  it('serves the stored bytes when the leading tag cannot be read', async () => {
    const seeded = await seedTrack();
    await storeBytes(seeded, AUDIO);
    // Ranged reads fail, so the tag cannot be sized; whole-object reads still work.
    const unreadableTags = {
      ...store.provider,
      readStream: async (key: string, range?: { start?: number; end?: number }) => {
        if (range) throw new Error('range read failed');
        return store.provider.readStream(key);
      },
    };

    const shared = { ...deps(), storage: unreadableTags };
    const [planned] = await planTrackDownloads(shared, [await downloadable(seeded)]);
    const body = await openTrackDownload(shared, planned!);
    expect(await readAllBytes(body.stream)).toEqual(AUDIO);
    expect(body.byteSize).toBe(AUDIO.length);
    // Nothing is known to be stale, and the next download probes again.
    expect(healEnqueueTrackIds(enqueueEmbedTrackMetadataBatch)).toEqual([]);
  });

  it('drops a track whose stored bytes are gone', async () => {
    const present = await seedTrack();
    const missing = await seedTrack({
      ownerUserId: present.ownerUserId,
      sessionId: present.sessionId,
    });
    await storeBytes(present, AUDIO);

    const planned = await planTrackDownloads(deps(), [
      await downloadable(missing),
      await downloadable(present),
    ]);
    expect(planned.map((entry) => entry.track.trackId)).toEqual([present.trackId]);
  });
});
