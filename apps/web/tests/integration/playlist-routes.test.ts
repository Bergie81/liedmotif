import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { coverImages } from '@liedmotif/db';
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

// Playlist routes (retention is playlist membership): CRUD, membership
// add/remove/reorder, the picker's atomic memberships apply, and the
// owner-scoped reads. Cross-owner ids read as 404 (no IDOR); the Favorites
// system playlist refuses rename/delete (409).

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET: listGet, POST: createPost } = await import('@/app/api/playlists/route');
const { POST: renamePost } = await import('@/app/api/playlists/rename/route');
const { POST: deletePost } = await import('@/app/api/playlists/delete/route');
const { GET: detailGet } = await import('@/app/api/playlists/detail/route');
const { POST: addPost } = await import('@/app/api/playlists/tracks/add/route');
const { POST: removePost } = await import('@/app/api/playlists/tracks/remove/route');
const { POST: orderPost } = await import('@/app/api/playlists/tracks/order/route');
const { POST: applyPost } = await import('@/app/api/playlists/memberships/apply/route');
const { POST: favoritePost } = await import('@/app/api/tracks/favorite/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function postJson(handler: (r: Request) => Promise<Response>, body: unknown) {
  return handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function getWith(handler: (r: Request) => Promise<Response>, params: Record<string, string>) {
  const url = new URL('http://localhost/api');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return handler(new Request(url));
}

/** Seed one owned ready track (with playable audio). Sessions are stopped so
 *  repeated seeds never trip the one-active-session invariant. */
async function seedTrack(
  ownerUserId: string,
  key: string,
  session: { title?: string; coverImageId?: string } = {},
): Promise<string> {
  const sessionId = await createSession(testDb.db, {
    ownerUserId,
    status: 'stopped',
    ...session,
  });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    audioStorageKey: `pl/${ownerUserId}/${key}.mp3`,
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlist-routes-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('playlist CRUD routes', () => {
  it('creates, lists (Favorites first after the star ensures it), renames, deletes', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedTrack(owner, 'a');

    const created = await (await postJson(createPost, { name: 'Deep Work' })).json();
    expect(created.ok).toBe(true);
    const playlistId = created.data.playlist.id as string;
    expect(created.data.playlist.kind).toBe('user');

    // Starring lazily mints the Favorites system playlist.
    await postJson(favoritePost, { trackId, favorited: true });

    const listed = await (await getWith(listGet, {})).json();
    expect(listed.data.playlists.map((p: { kind: string }) => p.kind)).toEqual([
      'favorites',
      'user',
    ]);
    expect(listed.data.playlists[0].trackCount).toBe(1);
    expect(listed.data.playlists[0].containsTrack).toBeNull();

    // Picker read: ?trackId= reports membership per playlist.
    const picker = await (await getWith(listGet, { trackId })).json();
    expect(
      picker.data.playlists.map((p: { kind: string; containsTrack: boolean }) => [
        p.kind,
        p.containsTrack,
      ]),
    ).toEqual([
      ['favorites', true],
      ['user', false],
    ]);

    const renamed = await postJson(renamePost, { playlistId, name: 'Deeper Work' });
    expect((await renamed.json()).data.name).toBe('Deeper Work');

    const deleted = await postJson(deletePost, { playlistId });
    expect((await deleted.json()).data.deleted).toBe(true);
    expect((await postJson(deletePost, { playlistId })).status).toBe(404);
  });

  it('pages the list behind an opaque cursor (Favorites riding page 1) and rejects a tampered one', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    for (const [index, name] of ['A', 'B', 'C'].entries()) {
      await postJson(createPost, { name });
      await testDb.pool.query(
        'update playlists set updated_at = $1 where owner_user_id = $2 and name = $3',
        [new Date(Date.UTC(2026, 6, 30, 12, index)), owner, name],
      );
    }

    const page1 = await (await getWith(listGet, { limit: '2' })).json();
    expect(page1.data.playlists.map((p: { name: string }) => p.name)).toEqual([
      'Favorites',
      'C',
      'B',
    ]);
    expect(page1.data.nextCursor).not.toBeNull();

    const page2 = await (
      await getWith(listGet, { limit: '2', cursor: page1.data.nextCursor })
    ).json();
    expect(page2.data.playlists.map((p: { name: string }) => p.name)).toEqual(['A']);
    expect(page2.data.nextCursor).toBeNull();

    expect((await getWith(listGet, { cursor: 'not-a-cursor' })).status).toBe(400);
  });

  it('refuses rename/delete of Favorites (409) and cross-owner access (404)', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedTrack(owner, 'a');
    await postJson(favoritePost, { trackId, favorited: true });
    const listed = await (await getWith(listGet, {})).json();
    const favoritesId = listed.data.playlists[0].id as string;

    expect((await postJson(renamePost, { playlistId: favoritesId, name: 'X' })).status).toBe(409);
    expect((await postJson(deletePost, { playlistId: favoritesId })).status).toBe(409);

    const attacker = await createUser(testDb.db);
    holder.ownerUserId = attacker;
    expect((await postJson(renamePost, { playlistId: favoritesId, name: 'X' })).status).toBe(404);
    expect((await getWith(detailGet, { playlistId: favoritesId })).status).toBe(404);

    holder.ownerUserId = null;
    expect((await getWith(listGet, {})).status).toBe(401);
  });
});

describe.skipIf(skip)('membership routes', () => {
  it('add appends + implies Save; remove resequences; last removal unsaves; order commits whole', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const sessionCoverImageId = randomUUID();
    await testDb.db.insert(coverImages).values({
      id: sessionCoverImageId,
      sourceType: 'generated',
      storageProvider: 'local-fs',
      storageKey: `covers/generated/${sessionCoverImageId}.webp`,
    });
    const a = await seedTrack(owner, 'a', {
      title: 'Night Focus',
      coverImageId: sessionCoverImageId,
    });
    const b = await seedTrack(owner, 'b');
    const c = await seedTrack(owner, 'c');
    const created = await (await postJson(createPost, { name: 'Mix' })).json();
    const playlistId = created.data.playlist.id as string;

    const added = await (await postJson(addPost, { playlistId, trackIds: [a, b, c] })).json();
    expect(added.data.added).toEqual([a, b, c]);
    expect(added.data.refused).toEqual([]);

    const detail = await (await getWith(detailGet, { playlistId })).json();
    expect(detail.data.playlist.trackCount).toBe(3);
    expect(detail.data.items.map((i: { id: string }) => i.id)).toEqual([a, b, c]);
    expect(detail.data.items[0].savedAt).not.toBeNull();
    expect(detail.data.items[0].audioUrl).toBe(`/api/audio/${a}`);
    expect(detail.data.items[0].originSessionTitle).toBe('Night Focus');
    expect(detail.data.items[0].coverImageId).toBe(sessionCoverImageId);
    expect(detail.data.items.map((i: { position: number }) => i.position)).toEqual([0, 1, 2]);

    const reordered = await (await postJson(orderPost, { playlistId, trackIds: [c, a, b] })).json();
    expect(reordered.data.trackIds).toEqual([c, a, b]);
    const afterReorder = await (await getWith(detailGet, { playlistId })).json();
    expect(afterReorder.data.items.map((i: { id: string }) => i.id)).toEqual([c, a, b]);
    // An order that is no longer the membership is a conflict, not a partial write.
    expect((await postJson(orderPost, { playlistId, trackIds: [c, a] })).status).toBe(409);

    const removed = await (await postJson(removePost, { playlistId, trackId: a })).json();
    expect(removed.data.removed).toBe(true);
    expect(removed.data.unsaved).toBe(true); // only membership -> left the Library
    const afterRemove = await (await getWith(detailGet, { playlistId })).json();
    expect(afterRemove.data.items.map((i: { id: string }) => i.id)).toEqual([c, b]);
    expect(afterRemove.data.items.map((i: { position: number }) => i.position)).toEqual([0, 1]);
    // Last membership gone -> Ephemeral.
    const flags = await testDb.pool.query('select saved_at from tracks where id = $1', [a]);
    expect(flags.rows[0].saved_at).toBeNull();
  });

  it('remove reports a Track deleted for good when its Session is gone', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const kept = await seedTrack(owner, 'kept');
    const orphan = await seedTrack(owner, 'orphan');
    await testDb.pool.query(
      `delete from activity_sessions where id = (
        select activity_session_id from generation_requests r
        join tracks t on t.generation_request_id = r.id where t.id = $1)`,
      [orphan],
    );
    const created = await (await postJson(createPost, { name: 'Mix' })).json();
    const playlistId = created.data.playlist.id as string;
    await postJson(addPost, { playlistId, trackIds: [kept, orphan] });

    const keptRemoved = await (await postJson(removePost, { playlistId, trackId: kept })).json();
    const orphanRemoved = await (
      await postJson(removePost, { playlistId, trackId: orphan })
    ).json();

    expect(keptRemoved.data).toMatchObject({ unsaved: true, deletedForGood: false });
    expect(orphanRemoved.data).toMatchObject({ unsaved: true, deletedForGood: true });
  });

  it('memberships apply commits the full picker diff atomically', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const trackId = await seedTrack(owner, 'a');
    const created = await (await postJson(createPost, { name: 'A' })).json();
    const aId = created.data.playlist.id as string;
    await postJson(addPost, { playlistId: aId, trackIds: [trackId] });

    const applied = await (
      await postJson(applyPost, {
        trackId,
        playlistIds: [],
        createPlaylistName: 'Fresh',
      })
    ).json();
    expect(applied.ok).toBe(true);
    expect(applied.data.playlistIds).toEqual([applied.data.createdPlaylistId]);
    expect(applied.data.flags.retentionClass).toBe('durable');

    const detailA = await (await getWith(detailGet, { playlistId: aId })).json();
    expect(detailA.data.items).toEqual([]);
  });

  it('detail pages members by position cursor', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const a = await seedTrack(owner, 'a');
    const b = await seedTrack(owner, 'b');
    const c = await seedTrack(owner, 'c');
    const created = await (await postJson(createPost, { name: 'Paged' })).json();
    const playlistId = created.data.playlist.id as string;
    await postJson(addPost, { playlistId, trackIds: [a, b, c] });

    const page1 = await (await getWith(detailGet, { playlistId, limit: '2' })).json();
    expect(page1.data.items.map((i: { id: string }) => i.id)).toEqual([a, b]);
    expect(page1.data.nextCursor).not.toBeNull();
    const page2 = await (
      await getWith(detailGet, { playlistId, limit: '2', cursor: page1.data.nextCursor })
    ).json();
    expect(page2.data.items.map((i: { id: string }) => i.id)).toEqual([c]);
    expect(page2.data.nextCursor).toBeNull();
  });
});
