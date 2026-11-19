import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { MAX_EXPORT_TRACKS } from '../generation/audio-asset-predicates';
import {
  addPlaylistTracks,
  applyTrackMemberships,
  createPlaylist,
  ensureFavoritesPlaylist,
} from './playlists-repo';
import { listPlaylists } from './playlist-reads';
import { setPlaylistShared } from './playlist-share-repo';
import { getOwnedPlaylistDownloadTracks } from './playlist-download-repo';

const skip = !TEST_DATABASE_URL;

const TABLES = ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES] as const;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlist-download-repo-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

/** An owned track, downloadable (local final) unless `streamOnly`. */
async function seedTrack(
  ownerUserId: string,
  fx: { title?: string; streamOnly?: boolean } = {},
): Promise<string> {
  const requestId = await createGenerationRequest(testDb.db, { ownerUserId });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: fx.title ?? null,
    ...(fx.streamOnly
      ? { status: 'streamable' as const, streamEncryptedSourceUrl: 'enc:stream' }
      : { audioStorageKey: `tracks/${ownerUserId}/s/${Math.random()}.mp3` }),
  });
}

describe.skipIf(skip)('getOwnedPlaylistDownloadTracks', () => {
  it('returns the playlist and its downloadable members in position order', async () => {
    const ownerUserId = await createUser(testDb.db);
    const trackA = await seedTrack(ownerUserId, { title: 'Alpha' });
    const trackB = await seedTrack(ownerUserId, { title: 'Beta' });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Road Trip' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackB, trackA],
    });

    const result = await getOwnedPlaylistDownloadTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
    });

    expect(result?.playlist).toMatchObject({ id: playlist.id, name: 'Road Trip' });
    expect(result?.tracks.map((t) => t.trackId)).toEqual([trackB, trackA]);
    expect(result?.tracks[1]).toMatchObject({ trackId: trackA, title: 'Alpha' });
  });

  it('skips stream-only members and works for the Favorites system playlist', async () => {
    const ownerUserId = await createUser(testDb.db);
    const downloadable = await seedTrack(ownerUserId);
    const streamOnly = await seedTrack(ownerUserId, { streamOnly: true });
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackIds: [streamOnly, downloadable],
    });

    const result = await getOwnedPlaylistDownloadTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
    });
    expect(result?.tracks.map((t) => t.trackId)).toEqual([downloadable]);
  });

  it('reads no more than the export ceiling, from the head of the order', async () => {
    // Every returned member costs the download plan a storage stat and a
    // tag-context row before a byte streams; unbounded, one request would fan a
    // whole library out over the storage backend.
    const ownerUserId = await createUser(testDb.db);
    const requestId = await createGenerationRequest(testDb.db, { ownerUserId });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackIds = await Promise.all(
      Array.from({ length: MAX_EXPORT_TRACKS + 1 }, (_, index) =>
        createTrack(testDb.db, {
          ownerUserId,
          generationRequestId: requestId,
          providerJobId: jobId,
          title: `Track ${index}`,
          audioStorageKey: `tracks/${ownerUserId}/s/${index}.mp3`,
        }),
      ),
    );
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Everything' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds });

    const result = await getOwnedPlaylistDownloadTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
    });

    expect(result?.tracks).toHaveLength(MAX_EXPORT_TRACKS);
    expect(result?.tracks.map((track) => track.trackId)).toEqual(
      trackIds.slice(0, MAX_EXPORT_TRACKS),
    );
    // Seeding a thousand rows takes about a second locally and over five on a loaded CI runner.
  }, 60_000);

  it('skips Shared references — a foreign member never reaches the zip selection', async () => {
    // A foreign, Lounge-audible, DOWNLOADABLE track saved into the caller's own
    // playlist: streamable to the visitor, but downloads never widen.
    const sharer = await createUser(testDb.db);
    const foreignTrack = await seedTrack(sharer, { title: 'Theirs' });
    const shelf = await createPlaylist(testDb.db, { ownerUserId: sharer, name: 'Shelf' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      trackIds: [foreignTrack],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      audience: { kind: 'everyone' },
    });

    const ownerUserId = await createUser(testDb.db);
    const ownTrack = await seedTrack(ownerUserId, { title: 'Mine' });
    const mixtape = await createPlaylist(testDb.db, { ownerUserId, name: 'Mixtape' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: mixtape.id,
      trackIds: [ownTrack],
    });
    await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId: foreignTrack,
      playlistIds: [mixtape.id],
    });

    const result = await getOwnedPlaylistDownloadTracks(testDb.db, {
      ownerUserId,
      playlistId: mixtape.id,
    });
    expect(result?.tracks.map((t) => t.trackId)).toEqual([ownTrack]);
  });

  it('the playlist summary counts exactly the members the zip selects', async () => {
    // The download menu rows gate on this count: a playlist of only Shared
    // references and stream-only members must read 0, or the row navigates to
    // the route's bare 404 page.
    const sharer = await createUser(testDb.db);
    const foreignTrack = await seedTrack(sharer);
    const shelf = await createPlaylist(testDb.db, { ownerUserId: sharer, name: 'Shelf' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      trackIds: [foreignTrack],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      audience: { kind: 'everyone' },
    });

    const ownerUserId = await createUser(testDb.db);
    const streamOnly = await seedTrack(ownerUserId, { streamOnly: true });
    const downloadable = await seedTrack(ownerUserId);
    const nothingToZip = await createPlaylist(testDb.db, { ownerUserId, name: 'Nothing' });
    const mixed = await createPlaylist(testDb.db, { ownerUserId, name: 'Mixed' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: nothingToZip.id,
      trackIds: [streamOnly],
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: mixed.id,
      trackIds: [streamOnly, downloadable],
    });
    await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId: foreignTrack,
      playlistIds: [nothingToZip.id, mixed.id],
    });

    const summaries = await listPlaylists(testDb.db, { ownerUserId });
    const counts = (id: string) => {
      const summary = summaries.find((playlist) => playlist.id === id);
      return [summary?.trackCount, summary?.downloadableTrackCount];
    };
    expect(counts(nothingToZip.id)).toEqual([2, 0]);
    expect(counts(mixed.id)).toEqual([3, 1]);
    for (const playlist of [nothingToZip, mixed]) {
      const selection = await getOwnedPlaylistDownloadTracks(testDb.db, {
        ownerUserId,
        playlistId: playlist.id,
      });
      expect(selection?.tracks).toHaveLength(counts(playlist.id)[1]!);
    }
  });

  it('returns null for a foreign or unknown playlist', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mine' });

    expect(
      await getOwnedPlaylistDownloadTracks(testDb.db, {
        ownerUserId: otherUserId,
        playlistId: playlist.id,
      }),
    ).toBeNull();
    expect(
      await getOwnedPlaylistDownloadTracks(testDb.db, {
        ownerUserId,
        playlistId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toBeNull();
  });
});
