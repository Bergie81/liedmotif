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

// The Lounge share route: owner-gated, with the uniform
// 404 refusal — a cross-owner playlistId must be byte-for-byte
// indistinguishable from an unknown one, so nothing leaks about what privately
// exists. Favorites and unlisted collections refuse with 409 (the kind gate);
// a `selected` audience naming no valid User refuses with 400.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { POST: sharePost, GET: shareGet } = await import('@/app/api/playlists/share/route');
const { POST: createPost } = await import('@/app/api/playlists/route');
const { GET: listGet } = await import('@/app/api/playlists/route');

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

async function createUserPlaylist(name: string): Promise<string> {
  const response = await postJson(createPost, { name });
  const payload = await response.json();
  return payload.data.playlist.id as string;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlist-share-route-test');
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

describe.skipIf(skip)('POST /api/playlists/share', () => {
  it('shares and unshares an owned user playlist, and the list marks it', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const playlistId = await createUserPlaylist('Mixtape');

    const shared = await postJson(sharePost, { playlistId, audience: { kind: 'everyone' } });
    expect(shared.status).toBe(200);
    const sharedPayload = await shared.json();
    expect(sharedPayload.data.playlistId).toBe(playlistId);
    expect(typeof sharedPayload.data.sharedAt).toBe('string');
    expect(sharedPayload.data.audience).toEqual({ kind: 'everyone' });

    const list = await listGet(new Request('http://localhost/api/playlists'));
    const listPayload = await list.json();
    const summary = listPayload.data.playlists.find((p: { id: string }) => p.id === playlistId) as {
      sharedAt: string | null;
    };
    expect(summary.sharedAt).toBe(sharedPayload.data.sharedAt);

    const unshared = await postJson(sharePost, { playlistId, audience: null });
    expect(unshared.status).toBe(200);
    const unsharedPayload = await unshared.json();
    expect(unsharedPayload.data.sharedAt).toBeNull();
    expect(unsharedPayload.data.audience).toBeNull();
  });

  it('a non-owner gets a refusal indistinguishable from an unknown id', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const playlistId = await createUserPlaylist('Private stash');

    holder.ownerUserId = await createUser(testDb.db);
    const crossOwner = await postJson(sharePost, { playlistId, audience: { kind: 'everyone' } });
    const unknown = await postJson(sharePost, {
      playlistId: randomUUID(),
      audience: { kind: 'everyone' },
    });

    expect(crossOwner.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossOwner.json()).toEqual(await unknown.json());

    const flipped = await testDb.pool.query(
      'select 1 from playlists where id = $1 and shared_at is not null',
      [playlistId],
    );
    expect(flipped.rowCount).toBe(0);
  });

  it('Favorites refuses with 409 (the kind gate holds at the route)', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    // Surface Favorites the way the app does: the list ensures it exists.
    await listGet(new Request('http://localhost/api/playlists'));
    const favorites = await testDb.pool.query("select id from playlists where kind = 'favorites'");
    const favoritesId = favorites.rows[0].id as string;

    const refused = await postJson(sharePost, {
      playlistId: favoritesId,
      audience: { kind: 'everyone' },
    });
    expect(refused.status).toBe(409);
  });
});

function getShare(playlistId: string) {
  return shareGet(new Request(`http://localhost/api/playlists/share?playlistId=${playlistId}`));
}

describe.skipIf(skip)('selected audience over the route', () => {
  it('shares with picked Users and reads the audience back with every other User as a candidate', async () => {
    const ownerUserId = await createUser(testDb.db);
    const mira = await createUser(testDb.db);
    await testDb.pool.query('update "user" set name = $1 where id = $2', ['Mira', mira]);
    holder.ownerUserId = ownerUserId;
    const playlistId = await createUserPlaylist('For Mira');

    const shared = await postJson(sharePost, {
      playlistId,
      audience: { kind: 'selected', userIds: [mira] },
    });
    expect(shared.status).toBe(200);
    expect((await shared.json()).data.audience).toEqual({ kind: 'selected', userIds: [mira] });

    const read = await getShare(playlistId);
    expect(read.status).toBe(200);
    const payload = (await read.json()).data;
    expect(payload).toEqual({
      playlistId,
      audience: { kind: 'selected', userIds: [mira] },
      candidates: [{ userId: mira, name: 'Mira', artistName: null, imageUrl: null }],
    });
    expect(JSON.stringify(payload)).not.toContain('@example.test');
  });

  it('refuses an audience that resolves to no valid User with 400, share untouched', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const playlistId = await createUserPlaylist('Lonely');

    const refused = await postJson(sharePost, {
      playlistId,
      audience: { kind: 'selected', userIds: [ownerUserId, 'user-ghost'] },
    });
    expect(refused.status).toBe(400);

    const read = await getShare(playlistId);
    expect((await read.json()).data.audience).toBeNull();
  });

  it('the read answers a cross-owner id exactly like an unknown one', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const playlistId = await createUserPlaylist('Private stash');

    holder.ownerUserId = await createUser(testDb.db);
    const crossOwner = await getShare(playlistId);
    const unknown = await getShare(randomUUID());

    expect(crossOwner.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossOwner.json()).toEqual(await unknown.json());
  });
});
