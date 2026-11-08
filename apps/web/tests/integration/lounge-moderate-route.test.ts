import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  addPlaylistTracks,
  createPlaylist,
  getPlaylistDetail,
  listLoungePlaylistsPage,
  setPlaylistLoungePinned,
  setPlaylistShared,
} from '@liedmotif/db';

// Admin moderation: the single cross-owner write. Returning a
// shared playlist to Private must ride the owner's own unshare chokepoint —
// full revocation purge (references AND pins), owner state untouched — and the
// route must refuse non-admins uniformly while a Private or unknown id stays
// a uniform 404 even to the Admin (private content leaks nothing).

const holder = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  role: 'member' as 'admin' | 'member',
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () =>
    holder.userId && holder.role === 'admin' ? { user: { id: holder.userId } } : null,
  getAppSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
}));

const { POST: moderatePost } = await import('@/app/api/lounge/moderate/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const TABLES = ['playlist_pins', 'playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES];

function postJson(body: unknown) {
  return moderatePost(
    new Request('http://localhost/api/lounge/moderate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** An owner's non-empty playlist, In Lounge unless told otherwise. */
async function seedOwnedPlaylist(shared = true): Promise<{
  ownerUserId: string;
  playlistId: string;
  trackId: string;
}> {
  const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Shelf' });
  await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [trackId] });
  if (shared) {
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });
  }
  return { ownerUserId, playlistId: playlist.id, trackId };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('lounge-moderate-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
  holder.userId = null;
  holder.role = 'member';
});

describe.skipIf(skip)('POST /api/lounge/moderate', () => {
  it('returns a foreign share to Private with the full revocation purge, owner untouched', async () => {
    const { ownerUserId, playlistId, trackId } = await seedOwnedPlaylist();
    // A visitor holding both pointer kinds — moderation must purge them like
    // the owner's own unshare would (never half-revoke).
    const visitorUserId = await createUser(testDb.db);
    const visitorShelf = await createPlaylist(testDb.db, {
      ownerUserId: visitorUserId,
      name: 'Keepers',
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: visitorUserId,
      playlistId: visitorShelf.id,
      trackIds: [trackId],
    });
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: visitorUserId,
      playlistId,
      pinned: true,
    });

    holder.userId = await createUser(testDb.db);
    holder.role = 'admin';
    const response = await postJson({ playlistId });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ playlistId });

    // Gone from the Lounge.
    const lounge = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: visitorUserId,
      limit: 10,
    });
    expect(lounge.items).toHaveLength(0);
    // Reference and pin purged.
    const shelf = await getPlaylistDetail(testDb.db, {
      ownerUserId: visitorUserId,
      playlistId: visitorShelf.id,
      limit: 10,
    });
    expect(shelf?.items).toHaveLength(0);
    const pins = await testDb.pool.query('select count(*)::int as n from playlist_pins');
    expect(pins.rows[0].n).toBe(0);
    // Owner keeps the playlist and its track, and can re-share.
    const owned = await getPlaylistDetail(testDb.db, { ownerUserId, playlistId, limit: 10 });
    expect(owned?.items.map((t) => t.id)).toEqual([trackId]);
    const reshared = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId,
      audience: { kind: 'everyone' },
    });
    expect(reshared).toMatchObject({ sharedAt: expect.any(Date) });
  });

  it('refuses a member identically for a real shared id and an unknown id, share untouched', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    holder.userId = await createUser(testDb.db);

    const real = await postJson({ playlistId });
    const unknown = await postJson({ playlistId: randomUUID() });
    expect(real.status).toBeGreaterThanOrEqual(400);
    expect(real.status).toBe(unknown.status);
    expect(await real.json()).toEqual(await unknown.json());

    const lounge = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: holder.userId!,
      limit: 10,
    });
    expect(lounge.items).toHaveLength(1);
  });

  it('answers the Admin a uniform 404 for a Private id and an unknown id', async () => {
    const { playlistId: privateId } = await seedOwnedPlaylist(false);
    holder.userId = await createUser(testDb.db);
    holder.role = 'admin';

    const priv = await postJson({ playlistId: privateId });
    const unknown = await postJson({ playlistId: randomUUID() });
    expect(priv.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await priv.json()).toEqual(await unknown.json());
  });

  it('cannot reach a playlist shared with selected Users that exclude the Admin', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    const member = await createUser(testDb.db);
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId,
      audience: { kind: 'selected', userIds: [member] },
    });
    holder.userId = await createUser(testDb.db);
    holder.role = 'admin';

    const hidden = await postJson({ playlistId });
    const unknown = await postJson({ playlistId: randomUUID() });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await unknown.json());

    const lounge = await listLoungePlaylistsPage(testDb.db, { viewerUserId: member, limit: 10 });
    expect(lounge.items.map((item) => item.id)).toEqual([playlistId]);
  });
});
