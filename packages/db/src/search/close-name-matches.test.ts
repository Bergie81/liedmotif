import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions } from '../schema';
import {
  addPlaylistTracks,
  createPlaylist,
  setPlaylistLoungePinned,
  setPlaylistShared,
} from '../playlists';
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
import { closeNameMatches } from './close-name-matches';

// A Search whose exact words found nothing answers with the Sessions, Tracks
// and Playlists spelled most like the query, closest first, as ordinary rows
// with the name as their Match context — and only rows exact Search could show.

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
  testDb = await connectTestDb('close-name-matches-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

const ALL_KINDS = ['sessions', 'tracks', 'playlists'] as const;

const stoppedSession = (ownerUserId: string, title: string) =>
  createSession(testDb.db, { ownerUserId, status: 'stopped', title });

const closeTo = (ownerUserId: string, query: string) =>
  closeNameMatches(testDb.db, { ownerUserId, query }, ALL_KINDS);

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

describe.skipIf(skip)('closeNameMatches', () => {
  it('finds a Session by a typo in its title, closest first, with its name as the match', async () => {
    const owner = await createUser(testDb.db);
    const meant = await stoppedSession(owner, 'Rainy Sunday Jazz');
    await stoppedSession(owner, 'Sunday Morning Haze');

    const close = await closeNameMatches(
      testDb.db,
      { ownerUserId: owner, query: 'Rainy Sunday Joz' },
      ALL_KINDS,
    );

    expect(close.sessions[0]).toMatchObject({
      id: meant,
      title: 'Rainy Sunday Jazz',
      status: 'stopped',
      match: { field: 'name', snippet: 'Rainy Sunday Jazz' },
    });
  });

  it('finds a Playlist written with "und" for "&", with no member match counted', async () => {
    const owner = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Focus & Flow' });

    const close = await closeTo(owner, 'Fokus und Flow');

    expect(close.playlists).toHaveLength(1);
    expect(close.playlists[0]).toMatchObject({
      id: playlist.id,
      name: 'Focus & Flow',
      memberMatchCount: 0,
      owner: null,
      match: { field: 'name', snippet: 'Focus & Flow' },
    });
  });

  it('finds a Track by a typo in its title, as a full Library row', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Quiet Corner');
    const track = await seedSessionTrack(testDb.db, owner, sessionId, {
      title: 'Sunday Morning Haze',
    });

    const close = await closeTo(owner, 'Sundy Morning Haze');

    expect(close.tracks[0]).toMatchObject({
      id: track,
      title: 'Sunday Morning Haze',
      status: 'ready',
      hasPlayableAudio: true,
      originSessionId: sessionId,
      originSessionTitle: 'Quiet Corner',
      match: { field: 'name', snippet: 'Sunday Morning Haze' },
    });
    expect(close.tracks[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('asks only for the kinds requested', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Rainy Sunday Jazz');
    await seedSessionTrack(testDb.db, owner, sessionId, { title: 'Rainy Sunday Jazz' });
    await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Rainy Sunday Jazz' });

    const close = await closeNameMatches(
      testDb.db,
      { ownerUserId: owner, query: 'Rainy Sunday Joz' },
      ['tracks'],
    );

    expect(close.tracks).toHaveLength(1);
    expect(close.sessions).toEqual([]);
    expect(close.playlists).toEqual([]);
  });

  it('offers at most five per kind', async () => {
    const owner = await createUser(testDb.db);
    for (let i = 0; i < 7; i += 1) await stoppedSession(owner, `Night Drive ${i}`);

    expect((await closeTo(owner, 'Nihgt Drive')).sessions).toHaveLength(5);
  });

  it('offers nothing when no name shares any spelling with the query', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Deep Focus');
    await seedSessionTrack(testDb.db, owner, sessionId, { title: 'Deep Focus' });
    await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Deep Focus' });

    expect(await closeTo(owner, 'lighthouse')).toEqual({
      sessions: [],
      tracks: [],
      playlists: [],
    });
  });

  it("never offers another User's private Session, Track or Playlist", async () => {
    const viewer = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const sessionId = await stoppedSession(other, 'Rainy Sunday Jazz');
    await seedSessionTrack(testDb.db, other, sessionId, { title: 'Rainy Sunday Jazz' });
    await createPlaylist(testDb.db, { ownerUserId: other, name: 'Rainy Sunday Jazz' });

    expect(await closeTo(viewer, 'Rainy Sunday Joz')).toEqual({
      sessions: [],
      tracks: [],
      playlists: [],
    });
  });

  it('offers a shared Playlist to a Visitor once pinned from the Lounge, with its owner, and never its Tracks', async () => {
    const owner = await createUser(testDb.db);
    const visitor = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Quiet Corner');
    const track = await seedSessionTrack(testDb.db, owner, sessionId, { title: 'Copper Nights' });
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Copper Nights' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      trackIds: [track],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });

    expect((await closeTo(visitor, 'Copper Nihgts')).playlists).toEqual([]);

    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: visitor,
      playlistId: playlist.id,
      pinned: true,
    });
    const close = await closeTo(visitor, 'Copper Nihgts');

    expect(ids(close.playlists)).toEqual([playlist.id]);
    expect(close.playlists[0]).toMatchObject({
      owner: { name: 'Test Admin', artistName: null, imageUrl: null },
      soleMemberTrackCount: 0,
      soleMemberDeletedTrackCount: 0,
    });
    expect(close.tracks).toEqual([]);
    expect(close.sessions).toEqual([]);
  });

  it('never offers a Session whose delete is pending', async () => {
    const owner = await createUser(testDb.db);
    const pending = await stoppedSession(owner, 'Rainy Sunday Jazz');
    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, pending));

    expect((await closeTo(owner, 'Rainy Sunday Joz')).sessions).toEqual([]);
  });
});
