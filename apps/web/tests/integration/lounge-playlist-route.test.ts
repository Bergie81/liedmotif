import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { addPlaylistTracks, createPlaylist, setPlaylistShared } from '@liedmotif/db';

// The visitor's playlist read: a foreign In-Lounge
// playlist answers 200 with attribution; unknown, private, and revoked ids
// answer one indistinguishable 404. Visitor listening leaves the owner's data
// untouched — the played stamp keeps its strict owner scope.

const holder = vi.hoisted(() => ({ db: null as unknown, viewerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
  getAppSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
}));

const { GET: loungePlaylistGet } = await import('@/app/api/lounge/playlist/route');
const { POST: playedPost } = await import('@/app/api/playlists/played/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('lounge-playlist-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES]);
  holder.viewerUserId = null;
});

async function seedShare(name: string): Promise<{ ownerUserId: string; playlistId: string }> {
  const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
  await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [trackId] });
  await setPlaylistShared(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    audience: { kind: 'everyone' },
    now: new Date('2026-08-12T10:00:00Z'),
  });
  return { ownerUserId, playlistId: playlist.id };
}

function detailRequest(playlistId: string): Request {
  return new Request(`http://localhost/api/lounge/playlist?playlistId=${playlistId}`);
}

describe.skipIf(skip)('GET /api/lounge/playlist', () => {
  it('serves a foreign In-Lounge playlist with owner attribution', async () => {
    const { ownerUserId, playlistId } = await seedShare('Rainy Balcony Tapes');
    await testDb.pool.query('update "user" set name = $1 where id = $2', [
      'Mira Marlowe',
      ownerUserId,
    ]);
    holder.viewerUserId = await createUser(testDb.db);

    const response = await loungePlaylistGet(detailRequest(playlistId));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: {
        playlist: { id: string; name: string; trackCount: number };
        owner: { name: string; artistName: string | null; imageUrl: string | null };
        items: Array<{ id: string }>;
        nextCursor: string | null;
      };
    };
    expect(payload.data.playlist.id).toBe(playlistId);
    expect(payload.data.playlist.trackCount).toBe(1);
    expect(payload.data.owner.name).toBe('Mira Marlowe');
    expect(payload.data.items).toHaveLength(1);
    expect(payload.data.nextCursor).toBeNull();
  });

  it('answers one indistinguishable 404 for unknown, private, and revoked ids', async () => {
    // Private: another owner's non-empty playlist that was never shared.
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const stash = await createPlaylist(testDb.db, { ownerUserId, name: 'Stash' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: stash.id,
      trackIds: [trackId],
    });
    // Revoked: shared, then returned to Private.
    const revoked = await seedShare('Was Shared');
    await setPlaylistShared(testDb.db, {
      ownerUserId: revoked.ownerUserId,
      playlistId: revoked.playlistId,
      audience: null,
    });
    holder.viewerUserId = await createUser(testDb.db);

    const responses = await Promise.all([
      loungePlaylistGet(detailRequest(randomUUID())),
      loungePlaylistGet(detailRequest(stash.id)),
      loungePlaylistGet(detailRequest(revoked.playlistId)),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const response of responses) expect(response.status).toBe(404);
    // Identical refusal bodies: nothing distinguishes "exists but private"
    // or "was shared once" from "never existed".
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('refuses a signed-out read (the Lounge is in-instance, never public)', async () => {
    const { playlistId } = await seedShare('Kitchen Discotheque');
    const response = await loungePlaylistGet(detailRequest(playlistId));
    expect(response.status).toBe(401);
  });
});

describe.skipIf(skip)('POST /api/playlists/played from a visitor', () => {
  it('keeps the played stamp owner-scoped: the visitor gets the uniform 404 and the owner’s lastPlayedAt stays untouched', async () => {
    const { playlistId } = await seedShare('Rainy Balcony Tapes');
    holder.viewerUserId = await createUser(testDb.db);

    const response = await playedPost(
      new Request('http://localhost/api/playlists/played', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playlistId }),
      }),
    );
    expect(response.status).toBe(404);

    const row = await testDb.pool.query('select last_played_at from playlists where id = $1', [
      playlistId,
    ]);
    expect(row.rows[0].last_played_at).toBeNull();
  });
});
