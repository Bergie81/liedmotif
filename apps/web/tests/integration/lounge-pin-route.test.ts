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
import { addPlaylistTracks, createPlaylist, setPlaylistShared } from '@liedmotif/db';

// The Pin route: viewer-scoped, with the uniform 404 refusal
// — a Private playlist and an unknown id must answer byte-for-byte identically,
// so a pin attempt can never probe what exists.

const holder = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
  getAppSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
}));

const { POST: pinPost } = await import('@/app/api/lounge/pin/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const TABLES = ['playlist_pins', 'playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES];

function postJson(body: unknown) {
  return pinPost(
    new Request('http://localhost/api/lounge/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** An owner's non-empty In-Lounge playlist (shared unless told otherwise). */
async function seedOwnedPlaylist(
  shared = true,
): Promise<{ ownerUserId: string; playlistId: string }> {
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
  return { ownerUserId, playlistId: playlist.id };
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('lounge-pin-route-test');
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
});

describe.skipIf(skip)('POST /api/lounge/pin', () => {
  it('pins and unpins a foreign In-Lounge playlist', async () => {
    const { playlistId } = await seedOwnedPlaylist();
    holder.userId = await createUser(testDb.db);

    const pinned = await postJson({ playlistId, pinned: true });
    expect(pinned.status).toBe(200);
    expect((await pinned.json()).data).toEqual({ playlistId, pinned: true });

    const unpinned = await postJson({ playlistId, pinned: false });
    expect(unpinned.status).toBe(200);
    expect((await unpinned.json()).data).toEqual({ playlistId, pinned: false });
  });

  it('pins the caller’s own In-Lounge playlist', async () => {
    const { ownerUserId, playlistId } = await seedOwnedPlaylist();
    holder.userId = ownerUserId;

    const pinned = await postJson({ playlistId, pinned: true });

    expect(pinned.status).toBe(200);
    expect((await pinned.json()).data).toEqual({ playlistId, pinned: true });
  });

  it('own Private, foreign Private, and unknown ids refuse byte-for-byte identically', async () => {
    const { ownerUserId, playlistId: ownPrivate } = await seedOwnedPlaylist(false);
    const { playlistId: foreignPrivate } = await seedOwnedPlaylist(false);
    holder.userId = ownerUserId;

    const own = await postJson({ playlistId: ownPrivate, pinned: true });
    const priv = await postJson({ playlistId: foreignPrivate, pinned: true });
    const unknown = await postJson({ playlistId: randomUUID(), pinned: true });

    expect(own.status).toBe(404);
    expect(priv.status).toBe(404);
    expect(unknown.status).toBe(404);
    const ownBody = await own.json();
    expect(ownBody).toEqual(await priv.json());
    expect(ownBody).toEqual(await unknown.json());

    const rows = await testDb.pool.query('select count(*)::int as n from playlist_pins');
    expect(rows.rows[0].n).toBe(0);
  });
});
