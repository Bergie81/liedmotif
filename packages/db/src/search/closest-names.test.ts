import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions } from '../schema';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { createPlaylist, setPlaylistLoungePinned, setPlaylistShared } from '../playlists';
import { closestNames } from './closest-names';

// The names offered when a search matched nothing: ranked by spelling alone,
// and only ever names the same user's search could have returned.

const TABLES = [
  'playlist_pins',
  'playlist_tracks',
  'playlists',
  ...GENERATION_FIXTURE_TABLES,
] as const;
const skip = !TEST_DATABASE_URL;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('closest-names-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

const stoppedSession = (ownerUserId: string, title: string) =>
  createSession(testDb.db, { ownerUserId, status: 'stopped', title });

const closest = (ownerUserId: string, kind: 'session' | 'playlist' | 'track', query: string) =>
  closestNames(testDb.db, { ownerUserId, kind, query, limit: 5 });

describe.skipIf(skip)('closestNames', () => {
  it('puts a name that holds the query whole before one that is a typo of it', async () => {
    const owner = await createUser(testDb.db);
    const holdsIt = await stoppedSession(owner, 'Deep Focus For Long Winter Nights');
    const typo = await stoppedSession(owner, 'Deep Focsu');

    expect(await closest(owner, 'session', 'deep focus')).toEqual([
      { id: holdsIt, name: 'Deep Focus For Long Winter Nights', owner: null },
      { id: typo, name: 'Deep Focsu', owner: null },
    ]);
  });

  it('offers a name with two letters swapped, before one that shares less', async () => {
    const owner = await createUser(testDb.db);
    const meant = await stoppedSession(owner, 'Night Owls');
    const other = await stoppedSession(owner, 'Night Shift');

    expect(await closest(owner, 'session', 'Nihgt Owls')).toEqual([
      { id: meant, name: 'Night Owls', owner: null },
      { id: other, name: 'Night Shift', owner: null },
    ]);
  });

  it('offers a short name with two letters swapped', async () => {
    const owner = await createUser(testDb.db);
    const meant = await stoppedSession(owner, 'Rain');

    expect(await closest(owner, 'session', 'Rian')).toEqual([
      { id: meant, name: 'Rain', owner: null },
    ]);
  });

  it('offers nothing when no name shares any spelling with the query', async () => {
    const owner = await createUser(testDb.db);
    await stoppedSession(owner, 'Deep Focus');

    expect(await closest(owner, 'session', 'lighthouse')).toEqual([]);
  });

  it('offers no more names than the limit', async () => {
    const owner = await createUser(testDb.db);
    for (const title of ['Night Owls', 'Night Shift', 'Night Drive']) {
      await stoppedSession(owner, title);
    }

    const names = await closestNames(testDb.db, {
      ownerUserId: owner,
      kind: 'session',
      query: 'Nihgt',
      limit: 2,
    });

    expect(names).toHaveLength(2);
  });

  it('leaves out a Session whose delete is pending', async () => {
    const owner = await createUser(testDb.db);
    const pending = await stoppedSession(owner, 'Rain');
    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, pending));

    expect(await closest(owner, 'session', 'Rainn')).toEqual([]);
  });

  it('leaves out a rejected and a deleted Track', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Quiet Corner');
    const kept = await seedSessionTrack(testDb.db, owner, sessionId, { title: 'Gate Check' });
    await seedSessionTrack(testDb.db, owner, sessionId, {
      title: 'Gate Check',
      status: 'rejected',
    });
    await seedSessionTrack(testDb.db, owner, sessionId, { title: 'Gate Check', status: 'deleted' });

    expect(await closest(owner, 'track', 'Gate Chekc')).toEqual([
      { id: kept, name: 'Gate Check', owner: null },
    ]);
  });

  it("offers another user's Playlist only once it is shared and pinned from the Lounge, attributed", async () => {
    const owner = await createUser(testDb.db);
    const visitor = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Copper Nights' });

    expect(await closest(visitor, 'playlist', 'Copper Nihgts')).toEqual([]);

    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });
    expect(await closest(visitor, 'playlist', 'Copper Nihgts')).toEqual([]);

    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: visitor,
      playlistId: playlist.id,
      pinned: true,
    });
    expect(await closest(visitor, 'playlist', 'Copper Nihgts')).toEqual([
      {
        id: playlist.id,
        name: 'Copper Nights',
        owner: { name: 'Test Admin', artistName: null, imageUrl: null },
      },
    ]);
  });
});
