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
import {
  addPlaylistTracks,
  createPlaylist,
  setPlaylistLoungePinned,
  setPlaylistShared,
} from '@liedmotif/db';

// The Lounge listing route: one instance-wide read every signed-in
// User gets in full — the viewer's own shares listed like everyone else's,
// with `yours` as the only viewer-dependent bit (the inline badge's fact).

const holder = vi.hoisted(() => ({ db: null as unknown, viewerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
  getAppSession: async () => (holder.viewerUserId ? { user: { id: holder.viewerUserId } } : null),
}));

const { GET: loungeGet } = await import('@/app/api/lounge/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('lounge-route-test');
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

async function seedShare(name: string, sharedAt: Date): Promise<string> {
  const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
  await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [trackId] });
  await setPlaylistShared(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    audience: { kind: 'everyone' },
    now: sharedAt,
  });
  return ownerUserId;
}

interface LoungePayload {
  data: {
    playlists: Array<{
      name: string;
      matchContext: { field: string; snippet: string } | null;
    }>;
  };
}

describe.skipIf(skip)('GET /api/lounge', () => {
  it('serves every owner’s shares to the viewer, flagging only the viewer’s own as yours', async () => {
    const mine = await seedShare('Deep Work Winners', new Date('2026-08-12T10:00:00Z'));
    await seedShare('Rainy Balcony Tapes', new Date('2026-08-12T11:00:00Z'));
    holder.viewerUserId = mine;

    const response = await loungeGet(new Request('http://localhost/api/lounge'));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: {
        playlists: Array<{ name: string; yours: boolean; ownerName: string; sharedAt: string }>;
        nextCursor: string | null;
      };
    };
    expect(payload.data.playlists.map((p) => p.name)).toEqual([
      'Rainy Balcony Tapes',
      'Deep Work Winners',
    ]);
    expect(payload.data.playlists.map((p) => p.yours)).toEqual([false, true]);
    expect(payload.data.playlists[0]?.ownerName).toBe('Test Admin');
    expect(payload.data.nextCursor).toBeNull();
  });

  it('narrows by query and owner together, naming the winning field on each row', async () => {
    const anna = await seedShare('Night Shift Radio', new Date('2026-08-12T10:00:00Z'));
    await seedShare('Night Owl Sessions', new Date('2026-08-12T11:00:00Z'));
    holder.viewerUserId = await createUser(testDb.db);

    const response = await loungeGet(
      new Request(`http://localhost/api/lounge?query=night&owner=${encodeURIComponent(anna)}`),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as LoungePayload;
    expect(payload.data.playlists.map((p) => p.name)).toEqual(['Night Shift Radio']);
    expect(payload.data.playlists[0]?.matchContext).toEqual({
      field: 'name',
      snippet: 'Night Shift Radio',
    });
  });

  it('lists a pinned own share first, flagged as pinned for its owner', async () => {
    const ownerUserId = await seedShare('Mine', new Date('2026-08-12T10:00:00Z'));
    await seedShare('Newer', new Date('2026-08-12T11:00:00Z'));
    const mine = await testDb.pool.query('select id from playlists where name = $1', ['Mine']);
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId: mine.rows[0].id,
      pinned: true,
    });
    holder.viewerUserId = ownerUserId;

    const response = await loungeGet(new Request('http://localhost/api/lounge'));
    const { playlists } = (await response.json()).data;

    expect(playlists).toMatchObject([
      { name: 'Mine', yours: true, pinned: true },
      { name: 'Newer', yours: false, pinned: false },
    ]);
  });

  it('refuses a signed-out read (the Lounge is in-instance, never public)', async () => {
    await seedShare('Kitchen Discotheque', new Date('2026-08-12T10:00:00Z'));
    const response = await loungeGet(new Request('http://localhost/api/lounge'));
    expect(response.status).toBe(401);
  });

  it('a viewer who shares nothing still sees the whole room (no owner scope leaks in)', async () => {
    await seedShare('Night Shift Radio', new Date('2026-08-12T10:00:00Z'));
    holder.viewerUserId = await createUser(testDb.db);

    const response = await loungeGet(new Request('http://localhost/api/lounge'));
    const payload = (await response.json()) as {
      data: { playlists: Array<{ yours: boolean }> };
    };
    expect(payload.data.playlists).toHaveLength(1);
    expect(payload.data.playlists[0]?.yours).toBe(false);
  });
});
