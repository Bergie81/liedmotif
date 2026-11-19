import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { createPlaylist, ensureFavoritesPlaylist } from '@liedmotif/db';
import { listPlaylistsResponseSchema } from '@liedmotif/shared';

// The Library pin route: owner-scoped, with the uniform 404 refusal, and the
// list route showing the pin in the contract shape.

const holder = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
  getAppSession: async () => (holder.userId ? { user: { id: holder.userId } } : null),
}));

const { POST: pinPost } = await import('@/app/api/playlists/pin/route');
const { GET: listGet } = await import('@/app/api/playlists/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const TABLES = ['playlist_pins', 'playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES];

function postJson(body: unknown) {
  return pinPost(
    new Request('http://localhost/api/playlists/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlist-pin-route-test');
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

describe.skipIf(skip)('POST /api/playlists/pin', () => {
  it('pins and unpins an own playlist, and the list route moves it to the front', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.userId = ownerUserId;
    const older = await createPlaylist(testDb.db, { ownerUserId, name: 'Older' });
    const newer = await createPlaylist(testDb.db, { ownerUserId, name: 'Newer' });
    await testDb.pool.query('update playlists set updated_at = $1 where id = $2', [
      new Date(Date.UTC(2026, 0, 1)),
      older.id,
    ]);

    const pinned = await postJson({ playlistId: older.id, pinned: true });
    expect(pinned.status).toBe(200);
    expect((await pinned.json()).data).toEqual({ playlistId: older.id, pinned: true });

    const listed = listPlaylistsResponseSchema.parse(
      await (await listGet(new Request('http://localhost/api/playlists'))).json(),
    );
    if (!listed.ok) throw new Error(listed.error.message);
    const curated = listed.data.playlists.filter((p) => p.kind === 'user');
    expect(curated.map((p) => p.id)).toEqual([older.id, newer.id]);
    expect(curated[0]!.pinnedAt).not.toBeNull();
    expect(curated[1]!.pinnedAt).toBeNull();

    const unpinned = await postJson({ playlistId: older.id, pinned: false });
    expect((await unpinned.json()).data).toEqual({ playlistId: older.id, pinned: false });
  });

  it('another owner’s, unknown, and Favorites ids refuse byte-for-byte identically', async () => {
    const stranger = await createUser(testDb.db);
    const theirs = await createPlaylist(testDb.db, { ownerUserId: stranger, name: 'Theirs' });
    const ownerUserId = await createUser(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    holder.userId = ownerUserId;

    const foreign = await postJson({ playlistId: theirs.id, pinned: true });
    const unknown = await postJson({ playlistId: randomUUID(), pinned: true });
    const system = await postJson({ playlistId: favorites.id, pinned: true });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(system.status).toBe(404);
    const foreignBody = await foreign.json();
    expect(foreignBody).toEqual(await unknown.json());
    expect(foreignBody).toEqual(await system.json());
  });

  it('refuses a signed-out caller', async () => {
    const response = await postJson({ playlistId: randomUUID(), pinned: true });
    expect(response.status).toBe(401);
  });
});
