import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPlaylistTracks,
  applyTrackMemberships,
  createPlaylist,
  deleteTrack,
  ensureFavoritesPlaylist,
  getListenerProfile,
  rejectDislikedTrack,
  renameTrack,
  setPlaylistShared,
  updateListenerProfile,
} from '@liedmotif/db';
import {
  connectTestDb,
  createCoverImage,
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
import { getOfflineManifestResponseSchema, type OfflineManifest } from '@liedmotif/shared';

// The offline manifest for one marked Playlist — the viewer's own, or one in
// their Lounge: the members the device may store (a Track the viewer can hear,
// with a servable local final), in position order, each with its byte size,
// metadata version, and whether it is another owner's Track held through the
// Lounge. Private-foreign, revoked, absent and malformed ids are one uniform
// 404, like the audio route.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
}));

vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET } = await import('@/app/api/offline/playlists/[playlistId]/route');

const skip = !TEST_DATABASE_URL;
const TABLES = ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES] as const;
let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('offline-playlist-manifest-route-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
  holder.db = testDb.db;
  holder.ownerUserId = null;
});

let keyCounter = 0;
async function seedTrack(
  ownerUserId: string,
  fx: {
    title?: string;
    streamOnly?: boolean;
    byteSize?: number;
    activitySessionId?: string;
    vocal?: boolean;
  } = {},
): Promise<string> {
  keyCounter += 1;
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    ...(fx.activitySessionId ? { activitySessionId: fx.activitySessionId } : {}),
  });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
    title: fx.title ?? null,
    durationSeconds: 120,
    genreTags: ['lofi'],
    ...(fx.vocal ? { vocalMode: 'vocal' as const, lyrics: 'la la la' } : {}),
    ...(fx.streamOnly
      ? { status: 'streamable' as const, streamEncryptedSourceUrl: 'enc:stream' }
      : {
          audioStorageKey: `tracks/${ownerUserId}/offline/${keyCounter}.mp3`,
          audioByteSize: fx.byteSize ?? 4_000_000,
        }),
  });
}

async function get(playlistId: string): Promise<Response> {
  return GET(new Request(`http://test.local/api/offline/playlists/${playlistId}`), {
    params: Promise.resolve({ playlistId }),
  });
}

async function manifest(playlistId: string): Promise<OfflineManifest> {
  const response = await get(playlistId);
  expect(response.status).toBe(200);
  const parsed = getOfflineManifestResponseSchema.parse(await response.json());
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.data;
}

describe.skipIf(skip)('GET /api/offline/playlists/[playlistId]', () => {
  it('counts the members it cannot list, so a device never takes a part for the whole', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const stored = await seedTrack(ownerUserId);
    const streaming = await seedTrack(ownerUserId, { streamOnly: true });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Commute' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [stored, streaming],
    });

    const result = await manifest(playlist.id);

    expect(result.tracks.map((track) => track.trackId)).toEqual([stored]);
    expect(result.leftOutTrackCount).toBe(1);
  });

  it('lists the storable members in position order with size, presentation and a version', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const cover = await createCoverImage(testDb.db, { byteSize: 70_000 });
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      title: 'Night Drive',
      coverImageId: cover,
    });
    const first = await seedTrack(ownerUserId, {
      title: 'Neon',
      byteSize: 5_000_000,
      activitySessionId: sessionId,
      vocal: true,
    });
    const second = await seedTrack(ownerUserId, { title: 'Dusk', byteSize: 3_000_000 });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Commute' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [second, first],
    });

    const result = await manifest(playlist.id);

    expect(result.name).toBe('Commute');
    expect(result.tracks.map((track) => track.trackId)).toEqual([second, first]);
    expect(result.tracks[1]).toMatchObject({
      trackId: first,
      byteSize: 5_000_000,
      title: 'Neon',
      originSessionTitle: 'Night Drive',
      durationSeconds: 120,
      coverImageId: cover,
      coverByteSize: 70_000,
      genreTags: ['lofi'],
      vocalMode: 'vocal',
      hasLyrics: true,
      fromLounge: false,
    });
    expect(result.tracks[0]).toMatchObject({
      trackId: second,
      originSessionTitle: null,
      coverImageId: null,
      coverByteSize: 0,
      vocalMode: 'instrumental',
      hasLyrics: false,
    });
  });

  it('counts a cover of unknown size as 0 bytes, as an unknown audio size counts', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const cover = await createCoverImage(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId, coverImageId: cover });
    const track = await seedTrack(ownerUserId, { activitySessionId: sessionId });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Old covers' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [track] });

    expect((await manifest(playlist.id)).tracks[0]).toMatchObject({
      coverImageId: cover,
      coverByteSize: 0,
    });
  });

  it('lists a Shared reference in the viewer’s own Playlist as from the Lounge, and never stream-only or Disliked members', async () => {
    const sharer = await createUser(testDb.db);
    const foreign = await seedTrack(sharer, { title: 'Theirs' });
    const shelf = await createPlaylist(testDb.db, { ownerUserId: sharer, name: 'Shelf' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      trackIds: [foreign],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      audience: { kind: 'everyone' },
    });

    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const kept = await seedTrack(ownerUserId, { title: 'Kept' });
    const streamOnly = await seedTrack(ownerUserId, { streamOnly: true });
    const disliked = await seedTrack(ownerUserId, { title: 'Nope' });
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackIds: [streamOnly, kept, disliked],
    });
    await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId: foreign,
      playlistIds: [favorites.id],
    });
    await rejectDislikedTrack(testDb.db, { ownerUserId, trackId: disliked });

    const result = await manifest(favorites.id);

    expect(result.tracks.map((track) => [track.trackId, track.fromLounge])).toEqual([
      [kept, false],
      [foreign, true],
    ]);
  });

  it('answers an empty Playlist with no Tracks rather than a 404', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Soon' });

    expect((await manifest(playlist.id)).tracks).toEqual([]);
  });

  it('keeps the version while nothing changes and moves it when the Track is renamed or its artist changes', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const track = await seedTrack(ownerUserId, { title: 'Before' });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'One' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [track] });

    const before = (await manifest(playlist.id)).tracks[0]!.version;
    expect((await manifest(playlist.id)).tracks[0]!.version).toBe(before);

    await renameTrack(testDb.db, { ownerUserId, trackId: track, title: 'After' });
    const renamed = (await manifest(playlist.id)).tracks[0]!.version;
    expect(renamed).not.toBe(before);

    // Track Data's artist is the owner's Artist Name, else their User name.
    const profile = (await getListenerProfile(testDb.db, ownerUserId))!;
    await updateListenerProfile(testDb.db, ownerUserId, { ...profile, artistName: 'Night Shift' });
    expect((await manifest(playlist.id)).tracks[0]!.version).not.toBe(renamed);
  });

  it('is one uniform 404 for a foreign, absent or malformed Playlist, and 401 signed out', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const track = await seedTrack(ownerUserId);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mine' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [track] });

    expect((await get(playlist.id)).status).toBe(401);

    holder.ownerUserId = otherUserId;
    expect((await get(playlist.id)).status).toBe(404);
    expect((await get('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
  });
});

describe.skipIf(skip)('GET /api/offline/playlists/[playlistId] for a Lounge Playlist', () => {
  /** An In-Lounge Playlist of `owner` holding the given Tracks, shared with everyone. */
  async function sharedPlaylist(ownerUserId: string, trackIds: string[], name = 'Shared') {
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });
    return playlist.id;
  }

  it('lists the members the Visitor can hear that have a stored local final, as from the Lounge', async () => {
    const owner = await createUser(testDb.db);
    const visitor = await createUser(testDb.db);
    // A third owner shares only with `owner`, who files the Track into the
    // Playlist they share with everyone: the Visitor still cannot hear it.
    const third = await createUser(testDb.db);
    const unheard = await seedTrack(third, { title: 'Not for you' });
    const narrow = await createPlaylist(testDb.db, { ownerUserId: third, name: 'Narrow' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: third,
      playlistId: narrow.id,
      trackIds: [unheard],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: third,
      playlistId: narrow.id,
      audience: { kind: 'selected', userIds: [owner] },
    });

    const first = await seedTrack(owner, { title: 'First', byteSize: 6_000_000 });
    const streamOnly = await seedTrack(owner, { streamOnly: true });
    const second = await seedTrack(owner, { title: 'Second' });
    const playlistId = await sharedPlaylist(owner, [second, streamOnly, first], 'Lounge mix');
    await applyTrackMemberships(testDb.db, {
      ownerUserId: owner,
      trackId: unheard,
      playlistIds: [playlistId],
    });

    holder.ownerUserId = visitor;
    const result = await manifest(playlistId);

    expect(result.name).toBe('Lounge mix');
    expect(result.tracks.map((track) => [track.trackId, track.fromLounge])).toEqual([
      [second, true],
      [first, true],
    ]);
    expect(result.tracks[1]).toMatchObject({ title: 'First', byteSize: 6_000_000 });
  });

  it('is the uniform 404 once the owner unshares the Playlist or narrows its audience past the Visitor, and drops the Visitor’s Shared references', async () => {
    const owner = await createUser(testDb.db);
    const visitor = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const track = await seedTrack(owner);
    const playlistId = await sharedPlaylist(owner, [track]);
    const own = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Mine' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId: track,
      playlistIds: [own.id],
    });
    holder.ownerUserId = visitor;
    expect((await manifest(playlistId)).tracks.map((entry) => entry.trackId)).toEqual([track]);
    expect((await manifest(own.id)).tracks.map((entry) => entry.trackId)).toEqual([track]);

    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId,
      audience: { kind: 'selected', userIds: [other] },
    });
    expect((await get(playlistId)).status).toBe(404);
    expect((await manifest(own.id)).tracks).toEqual([]);

    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId,
      audience: { kind: 'everyone' },
    });
    expect((await manifest(playlistId)).tracks).toHaveLength(1);
    await setPlaylistShared(testDb.db, { ownerUserId: owner, playlistId, audience: null });
    expect((await get(playlistId)).status).toBe(404);
  });

  it('drops a Track the owner deletes from the Lounge Playlist and from the Visitor’s own Playlists', async () => {
    const owner = await createUser(testDb.db);
    const visitor = await createUser(testDb.db);
    const deleted = await seedTrack(owner, { title: 'Gone' });
    const stays = await seedTrack(owner, { title: 'Stays' });
    const playlistId = await sharedPlaylist(owner, [deleted, stays]);
    const own = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Mine' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId: deleted,
      playlistIds: [own.id],
    });

    await deleteTrack(testDb.db, { ownerUserId: owner, trackId: deleted });

    holder.ownerUserId = visitor;
    expect((await manifest(playlistId)).tracks.map((entry) => entry.trackId)).toEqual([stays]);
    expect((await manifest(own.id)).tracks).toEqual([]);
  });
});
