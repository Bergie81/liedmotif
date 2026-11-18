import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  GENERATION_FIXTURE_TABLES,
  createCoverImage,
  createSession,
  createUser,
  seedReadyTrack,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  addPlaylistTracks,
  applyTrackMemberships,
  convertSessionToPlaylist,
  createPlaylist,
  ensureFavoritesPlaylist,
  deletePlaylist,
  getPlaylistDetail,
  listPlaylists,
  listPlaylistsPage,
  removePlaylistTrack,
  renamePlaylist,
  setPlaylistOrder,
  setTrackFavorited,
  touchPlaylistPlayed,
  unsaveTrackEverywhere,
} from './playlists-repo';
import { getPlaylistShare, setPlaylistShared } from './playlist-share-repo';
import { getOwnedTrackSummary, rejectDislikedTrack } from '../generation/feedback-repo';
import { deleteTrack } from '../generation/delete-track-repo';
import { createTrack, createGenerationRequest, createProviderJob } from '../testing';

async function trackFlags(trackId: string) {
  const result = await testDb.pool.query(
    'select saved_at, favorited_at from tracks where id = $1',
    [trackId],
  );
  return { savedAt: result.rows[0].saved_at, favoritedAt: result.rows[0].favorited_at };
}

async function memberPositions(playlistId: string): Promise<Array<[string, number]>> {
  const result = await testDb.pool.query(
    'select track_id, position from playlist_tracks where playlist_id = $1 order by position',
    [playlistId],
  );
  return result.rows.map((r) => [r.track_id, r.position]);
}

async function auditCount(trackId: string, type: string): Promise<number> {
  const result = await testDb.pool.query(
    'select count(*)::int as n from feedback_events where track_id = $1 and feedback_type = $2',
    [trackId, type],
  );
  return result.rows[0].n as number;
}

/** Seed a second ready track owned by the same user (same session chain). */
async function seedSiblingTrack(ownerUserId: string): Promise<string> {
  const requestId = await createGenerationRequest(testDb.db, { ownerUserId });
  const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId: jobId,
  });
}

// Playlists repo: membership is the source
// of retention truth; `savedAt`/`favoritedAt` are denormalizations kept in sync
// inside every membership transaction. All operations are owner-scoped (the 404
// IDOR posture: cross-owner ids read as absent).

const skip = !TEST_DATABASE_URL;
const NOW = new Date('2026-07-23T12:00:00Z');

/** A fixed-clock timestamp `minutes` after NOW. */
function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

// `cover_images` is instance-global and not in the shared fixture list, but the
// cover-reclaim tests seed rows there — truncate it so runs stay independent.
const TABLES = [
  'playlist_tracks',
  'playlists',
  'cover_images',
  ...GENERATION_FIXTURE_TABLES,
] as const;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('playlists-repo-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

describe.skipIf(skip)('ensureFavoritesPlaylist / createPlaylist / listPlaylists', () => {
  it('lazily creates exactly one Favorites system playlist per owner', async () => {
    const ownerUserId = await createUser(testDb.db);

    const first = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    const second = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    expect(first.id).toBe(second.id);
    expect(first.kind).toBe('favorites');
    expect(first.name).toBe('Favorites');
    expect(first.listedInPlaylists).toBe(false);
  });

  it('creates user playlists and lists them favorites-first with track counts', async () => {
    const ownerUserId = await createUser(testDb.db);
    await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    const beach = await createPlaylist(testDb.db, { ownerUserId, name: 'Beach drive' });
    expect(beach.kind).toBe('user');
    expect(beach.name).toBe('Beach drive');
    expect(beach.listedInPlaylists).toBe(true);

    const listed = await listPlaylists(testDb.db, { ownerUserId });
    expect(listed.map((p) => p.kind)).toEqual(['favorites', 'user']);
    expect(listed.map((p) => p.listedInPlaylists)).toEqual([false, true]);
    expect(listed.map((p) => p.trackCount)).toEqual([0, 0]);

    // Owner-scoped: another user sees none of it.
    const other = await createUser(testDb.db);
    expect(await listPlaylists(testDb.db, { ownerUserId: other })).toEqual([]);
  });

  it('sums member durations into totalDurationSeconds, counting unknown durations as 0', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const second = await seedSiblingTrack(ownerUserId);
    const unknown = await seedSiblingTrack(ownerUserId);
    await testDb.pool.query('update tracks set duration_seconds = 180 where id = $1', [trackId]);
    await testDb.pool.query('update tracks set duration_seconds = 65 where id = $1', [second]);

    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mixtape' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId, second, unknown],
    });
    const empty = await createPlaylist(testDb.db, { ownerUserId, name: 'Empty' });

    const listed = await listPlaylists(testDb.db, { ownerUserId });
    expect(listed.find((p) => p.id === playlist.id)?.totalDurationSeconds).toBe(245);
    expect(listed.find((p) => p.id === empty.id)?.totalDurationSeconds).toBe(0);
  });
});

describe.skipIf(skip)('convertSessionToPlaylist', () => {
  async function playlistCount(ownerUserId: string): Promise<number> {
    const result = await testDb.pool.query(
      'select count(*)::int as n from playlists where owner_user_id = $1',
      [ownerUserId],
    );
    return result.rows[0].n as number;
  }

  async function playlistName(playlistId: string): Promise<string> {
    const result = await testDb.pool.query('select name, kind from playlists where id = $1', [
      playlistId,
    ]);
    expect(result.rows[0].kind).toBe('user');
    return result.rows[0].name as string;
  }

  it('files every listed Track, oldest first, into a new Playlist named after the Session', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Late Drive',
    });
    const newest = await seedSessionTrack(testDb.db, owner, sessionId, { createdAt: at(30) });
    const oldest = await seedSessionTrack(testDb.db, owner, sessionId, { createdAt: at(10) });
    const middle = await seedSessionTrack(testDb.db, owner, sessionId, { createdAt: at(20) });

    const result = await convertSessionToPlaylist(testDb.db, {
      ownerUserId: owner,
      sessionId,
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, trackCount: 3 });
    if (!result.ok) throw new Error('unreachable');
    expect(await playlistName(result.playlistId)).toBe('Late Drive');
    expect(await memberPositions(result.playlistId)).toEqual([
      [oldest, 0],
      [middle, 1],
      [newest, 2],
    ]);
  });

  it('makes the Tracks Durable and leaves the Session as it is', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'active',
      title: 'Late Drive',
    });
    const trackId = await seedSessionTrack(testDb.db, owner, sessionId);

    const result = await convertSessionToPlaylist(testDb.db, {
      ownerUserId: owner,
      sessionId,
      now: NOW,
    });

    expect(result.ok).toBe(true);
    expect((await trackFlags(trackId)).savedAt).toEqual(NOW);
    expect(await auditCount(trackId, 'save')).toBe(1);
    const session = await testDb.pool.query(
      'select status, title from activity_sessions where id = $1',
      [sessionId],
    );
    expect(session.rows[0]).toEqual({ status: 'active', title: 'Late Drive' });
  });

  it('takes what an active Session has so far: a Track generated later stays out', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner, status: 'active' });
    const kept = await seedSessionTrack(testDb.db, owner, sessionId);

    const result = await convertSessionToPlaylist(testDb.db, { ownerUserId: owner, sessionId });
    await seedSessionTrack(testDb.db, owner, sessionId);

    if (!result.ok) throw new Error('unreachable');
    expect((await memberPositions(result.playlistId)).map(([id]) => id)).toEqual([kept]);
  });

  it('leaves out every Track the Session list does not show', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner, status: 'stopped' });
    const kept = await seedSessionTrack(testDb.db, owner, sessionId);
    await seedSessionTrack(testDb.db, owner, sessionId, { dislikedAt: NOW });
    await seedSessionTrack(testDb.db, owner, sessionId, { status: 'rejected' });
    await seedSessionTrack(testDb.db, owner, sessionId, { status: 'deleted' });
    await seedSessionTrack(testDb.db, owner, sessionId, { queueState: 'rejected' });
    await seedSessionTrack(testDb.db, owner, sessionId, { playable: false });

    const result = await convertSessionToPlaylist(testDb.db, { ownerUserId: owner, sessionId });

    expect(result).toMatchObject({ ok: true, trackCount: 1 });
    if (!result.ok) throw new Error('unreachable');
    expect((await memberPositions(result.playlistId)).map(([id]) => id)).toEqual([kept]);
  });

  it('creates no Playlist for a Session with no Tracks', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner, status: 'stopped' });

    const result = await convertSessionToPlaylist(testDb.db, { ownerUserId: owner, sessionId });

    expect(result).toEqual({ ok: false, reason: 'no_tracks' });
    expect(await playlistCount(owner)).toBe(0);
  });

  it("treats another owner's Session as not found", async () => {
    const owner = await createUser(testDb.db);
    const stranger = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner, status: 'stopped' });
    const trackId = await seedSessionTrack(testDb.db, owner, sessionId);

    const result = await convertSessionToPlaylist(testDb.db, {
      ownerUserId: stranger,
      sessionId,
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(await playlistCount(stranger)).toBe(0);
    expect((await trackFlags(trackId)).savedAt).toBeNull();
  });

  it('treats a Session whose delete is pending as not found', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: owner, status: 'stopped' });
    await seedSessionTrack(testDb.db, owner, sessionId);
    await testDb.pool.query(
      'update activity_sessions set delete_requested_at = now() where id = $1',
      [sessionId],
    );

    const result = await convertSessionToPlaylist(testDb.db, { ownerUserId: owner, sessionId });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it.each([
    ['cuts a long title to the Playlist name limit', 'a'.repeat(70), 'a'.repeat(60)],
    ['drops whitespace the cut leaves at the end', `${'a'.repeat(59)} tail`, 'a'.repeat(59)],
    ['falls back when the Session has no title', null, 'Untitled Session'],
  ])('%s', async (_label, title, expected) => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title,
    });
    await seedSessionTrack(testDb.db, owner, sessionId);

    const result = await convertSessionToPlaylist(testDb.db, { ownerUserId: owner, sessionId });

    if (!result.ok) throw new Error('expected a Playlist');
    expect(await playlistName(result.playlistId)).toBe(expected);
  });

  it('mints a separate Playlist each time, under the same name', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Late Drive',
    });
    await seedSessionTrack(testDb.db, owner, sessionId);

    const first = await convertSessionToPlaylist(testDb.db, { ownerUserId: owner, sessionId });
    const second = await convertSessionToPlaylist(testDb.db, { ownerUserId: owner, sessionId });

    if (!first.ok || !second.ok) throw new Error('expected Playlists');
    expect(second.playlistId).not.toBe(first.playlistId);
    expect(await playlistCount(owner)).toBe(2);
  });
});

describe.skipIf(skip)('listPlaylists activity order / touchPlaylistPlayed', () => {
  /** Stage a playlist's last membership-change time (`minutes` after NOW). */
  async function setUpdatedAt(playlistId: string, minutes: number): Promise<void> {
    await testDb.pool.query('update playlists set updated_at = $1 where id = $2', [
      at(minutes),
      playlistId,
    ]);
  }

  it('orders by the most recent of membership change and last play (Favorites still pinned)', async () => {
    const ownerUserId = await createUser(testDb.db);
    await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    const edited = await createPlaylist(testDb.db, { ownerUserId, name: 'Edited' });
    const played = await createPlaylist(testDb.db, { ownerUserId, name: 'Played' });
    const idle = await createPlaylist(testDb.db, { ownerUserId, name: 'Idle' });
    await setUpdatedAt(idle.id, 0);
    await setUpdatedAt(edited.id, 10);
    await setUpdatedAt(played.id, 5);
    const touched = await touchPlaylistPlayed(testDb.db, {
      ownerUserId,
      playlistId: played.id,
      now: at(20),
    });
    expect(touched).toBe(true);

    const listed = await listPlaylists(testDb.db, { ownerUserId });
    expect(listed.map((p) => p.name)).toEqual(['Favorites', 'Played', 'Edited', 'Idle']);
    // A play must not masquerade as a membership change.
    expect(listed.find((p) => p.id === played.id)?.updatedAt).toEqual(at(5));
    expect(listed.find((p) => p.id === played.id)?.lastPlayedAt).toEqual(at(20));
  });

  it('is owner-scoped: a cross-owner touch is refused and changes nothing', async () => {
    const ownerUserId = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mine' });

    expect(
      await touchPlaylistPlayed(testDb.db, { ownerUserId: other, playlistId: playlist.id }),
    ).toBe(false);
    const row = await testDb.pool.query('select last_played_at from playlists where id = $1', [
      playlist.id,
    ]);
    expect(row.rows[0].last_played_at).toBeNull();
  });
});

describe.skipIf(skip)('listPlaylistsPage keyset paging', () => {
  /** Stage a playlist's last membership-change time (`minutes` after NOW). */
  async function setUpdatedAt(playlistId: string, minutes: number): Promise<void> {
    await testDb.pool.query('update playlists set updated_at = $1 where id = $2', [
      at(minutes),
      playlistId,
    ]);
  }

  /** Seed one owner with Favorites and named user playlists at 1-minute activity steps. */
  async function seedOwnerWithPlaylists(names: string[]): Promise<string> {
    const ownerUserId = await createUser(testDb.db);
    await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    for (const [index, name] of names.entries()) {
      const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
      await setUpdatedAt(playlist.id, index + 1);
    }
    return ownerUserId;
  }

  it('pins Favorites to the first page and walks user playlists by activity', async () => {
    const ownerUserId = await seedOwnerWithPlaylists(['A', 'B', 'C', 'D', 'E']);

    const first = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 2 });
    expect(first.items.map((p) => p.name)).toEqual(['Favorites', 'E', 'D']);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPlaylistsPage(testDb.db, {
      ownerUserId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((p) => p.name)).toEqual(['C', 'B']);
    expect(second.nextCursor).not.toBeNull();

    const third = await listPlaylistsPage(testDb.db, {
      ownerUserId,
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items.map((p) => p.name)).toEqual(['A']);
    expect(third.nextCursor).toBeNull();
  });

  it('ends exactly at the last page when the tail fills it', async () => {
    const ownerUserId = await seedOwnerWithPlaylists(['A', 'B']);

    const first = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 2 });
    expect(first.items.map((p) => p.name)).toEqual(['Favorites', 'B', 'A']);
    expect(first.nextCursor).toBeNull();
  });

  it('applies the search filter on every page and stays owner-scoped', async () => {
    const ownerUserId = await seedOwnerWithPlaylists(['Chill morning', 'Workout', 'Chill evening']);

    const first = await listPlaylistsPage(testDb.db, { ownerUserId, search: 'chill', limit: 1 });
    expect(first.items.map((p) => p.name)).toEqual(['Chill evening']);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPlaylistsPage(testDb.db, {
      ownerUserId,
      search: 'chill',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((p) => p.name)).toEqual(['Chill morning']);
    expect(second.nextCursor).toBeNull();

    const other = await createUser(testDb.db);
    const foreign = await listPlaylistsPage(testDb.db, { ownerUserId: other, limit: 2 });
    expect(foreign.items).toEqual([]);
    expect(foreign.nextCursor).toBeNull();
  });
});

describe.skipIf(skip)('addPlaylistTracks', () => {
  it('appends in order, implies Save, and is idempotent per track', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const second = await seedSiblingTrack(ownerUserId);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Focus' });

    const result = await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId, second],
      now: NOW,
    });
    expect(result?.added).toEqual([trackId, second]);
    expect(await memberPositions(playlist.id)).toEqual([
      [trackId, 0],
      [second, 1],
    ]);
    expect((await trackFlags(trackId)).savedAt).toEqual(NOW);
    expect((await trackFlags(trackId)).favoritedAt).toBeNull();
    expect(await auditCount(trackId, 'save')).toBe(1);

    // Idempotent re-add: no duplicate row, no new audit, position unchanged.
    const again = await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
    });
    expect(again?.added).toEqual([]);
    expect(await memberPositions(playlist.id)).toEqual([
      [trackId, 0],
      [second, 1],
    ]);
    expect(await auditCount(trackId, 'save')).toBe(1);
  });

  it('adding to Favorites also sets favoritedAt (favorite implies save)', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });

    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackIds: [trackId],
      now: NOW,
    });
    const flags = await trackFlags(trackId);
    expect(flags.savedAt).toEqual(NOW);
    expect(flags.favoritedAt).toEqual(NOW);
    expect(await auditCount(trackId, 'favorite')).toBe(1);
  });

  it('refuses rejected/deleted tracks and is owner-scoped on both sides', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mix' });
    await testDb.pool.query("update tracks set status = 'rejected' where id = $1", [trackId]);

    const result = await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
    });
    expect(result?.added).toEqual([]);
    expect(result?.refused).toEqual([trackId]);
    expect(await memberPositions(playlist.id)).toEqual([]);

    // Cross-owner playlist id reads as absent.
    const other = await createUser(testDb.db);
    expect(
      await addPlaylistTracks(testDb.db, {
        ownerUserId: other,
        playlistId: playlist.id,
        trackIds: [trackId],
      }),
    ).toBeNull();

    // Cross-owner track id is refused, not added.
    const { trackId: foreignTrack } = await seedReadyTrack(testDb.db);
    const scoped = await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [foreignTrack],
    });
    expect(scoped?.added).toEqual([]);
    expect(scoped?.refused).toEqual([foreignTrack]);
  });
});

describe.skipIf(skip)('removePlaylistTrack', () => {
  it('resequences positions and unsaves on last-membership removal', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const second = await seedSiblingTrack(ownerUserId);
    const third = await seedSiblingTrack(ownerUserId);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Trims' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId, second, third],
      now: NOW,
    });

    const removed = await removePlaylistTrack(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackId: second,
    });
    expect(removed?.removed).toBe(true);
    expect(removed?.unsaved).toBe(true); // last membership -> left the Library
    expect(await memberPositions(playlist.id)).toEqual([
      [trackId, 0],
      [third, 1],
    ]);
    // Last membership gone => back to Ephemeral, with an unsave audit.
    expect((await trackFlags(second)).savedAt).toBeNull();
    expect(await auditCount(second, 'unsave')).toBe(1);

    // Removing a non-member is a no-op, not an error.
    const again = await removePlaylistTrack(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackId: second,
    });
    expect(again?.removed).toBe(false);
  });

  it('keeps a track Durable while another membership remains; Favorites removal unfavorites', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Keep' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackIds: [trackId],
      now: NOW,
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
      now: NOW,
    });

    const unstarred = await removePlaylistTrack(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackId,
    });
    expect(unstarred?.unsaved).toBe(false); // still a member of "Keep"
    const flags = await trackFlags(trackId);
    expect(flags.savedAt).toEqual(NOW); // still a member of "Keep"
    expect(flags.favoritedAt).toBeNull(); // unstar via Favorites removal
    expect(await auditCount(trackId, 'unfavorite')).toBe(1);
    expect(await auditCount(trackId, 'unsave')).toBe(0);
  });
});

describe.skipIf(skip)('setPlaylistOrder', () => {
  async function seedOrderedPlaylist() {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const b = await seedSiblingTrack(ownerUserId);
    const c = await seedSiblingTrack(ownerUserId);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Order' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId, b, c],
    });
    return { ownerUserId, playlistId: playlist.id, a: trackId, b, c };
  }

  it('writes the given order densely', async () => {
    const { ownerUserId, playlistId, a, b, c } = await seedOrderedPlaylist();

    const result = await setPlaylistOrder(testDb.db, {
      ownerUserId,
      playlistId,
      trackIds: [c, a, b],
    });

    expect(result).toEqual({ trackIds: [c, a, b] });
    expect(await memberPositions(playlistId)).toEqual([
      [c, 0],
      [a, 1],
      [b, 2],
    ]);
  });

  it('refuses an order that is not exactly the current membership', async () => {
    const { ownerUserId, playlistId, a, b, c } = await seedOrderedPlaylist();
    const ghost = await seedSiblingTrack(ownerUserId);

    expect(await setPlaylistOrder(testDb.db, { ownerUserId, playlistId, trackIds: [c, a] })).toBe(
      'stale',
    );
    expect(
      await setPlaylistOrder(testDb.db, { ownerUserId, playlistId, trackIds: [c, a, b, ghost] }),
    ).toBe('stale');
    expect(
      await setPlaylistOrder(testDb.db, { ownerUserId, playlistId, trackIds: [c, a, a] }),
    ).toBe('stale');
    // Refused writes leave the order untouched.
    expect(await memberPositions(playlistId)).toEqual([
      [a, 0],
      [b, 1],
      [c, 2],
    ]);
  });

  it('reorders a long list without touching the same tracks in another playlist', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const trackIds = [trackId];
    for (let i = 1; i < 20; i += 1) trackIds.push(await seedSiblingTrack(ownerUserId));
    const target = await createPlaylist(testDb.db, { ownerUserId, name: 'Long' });
    const other = await createPlaylist(testDb.db, { ownerUserId, name: 'Untouched' });
    for (const playlistId of [target.id, other.id]) {
      await addPlaylistTracks(testDb.db, { ownerUserId, playlistId, trackIds });
    }

    // A partial reorder: one track moves to the front, every other row keeps
    // the position it already had — the case a bulk write must get right for
    // both the rows it moves and the rows it skips.
    const moved = [trackIds[19]!, ...trackIds.slice(0, 19)];
    expect(
      await setPlaylistOrder(testDb.db, { ownerUserId, playlistId: target.id, trackIds: moved }),
    ).toEqual({ trackIds: moved });
    expect(await memberPositions(target.id)).toEqual(moved.map((id, index) => [id, index]));
    // Membership rows are per playlist: reordering one must not renumber the
    // same tracks where they also live.
    expect(await memberPositions(other.id)).toEqual(trackIds.map((id, index) => [id, index]));
  });

  it('answers null for a playlist the caller does not own', async () => {
    const { playlistId, a, b, c } = await seedOrderedPlaylist();
    const stranger = await createUser(testDb.db);

    expect(
      await setPlaylistOrder(testDb.db, {
        ownerUserId: stranger,
        playlistId,
        trackIds: [c, b, a],
      }),
    ).toBeNull();
  });
});

describe.skipIf(skip)('renamePlaylist / deletePlaylist', () => {
  it('renames user playlists and refuses the Favorites system playlist', async () => {
    const ownerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Old name' });
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });

    const renamed = await renamePlaylist(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      name: 'New name',
    });
    expect(renamed).toBe('renamed');

    expect(
      await renamePlaylist(testDb.db, { ownerUserId, playlistId: favorites.id, name: 'Nope' }),
    ).toBe('system');
    // Cross-owner: absent.
    const other = await createUser(testDb.db);
    expect(
      await renamePlaylist(testDb.db, { ownerUserId: other, playlistId: playlist.id, name: 'X' }),
    ).toBeNull();
  });

  it('delete removes memberships, unsaves orphans, keeps multi-membership tracks Durable, refuses Favorites', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const shared = await seedSiblingTrack(ownerUserId);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    const doomed = await createPlaylist(testDb.db, { ownerUserId, name: 'Doomed' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: doomed.id,
      trackIds: [trackId, shared],
      now: NOW,
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackIds: [shared],
      now: NOW,
    });

    const result = await deletePlaylist(testDb.db, { ownerUserId, playlistId: doomed.id });
    expect(result).toBe('deleted');
    // Orphaned member left the Library; the shared one stays Durable (still favorited).
    expect((await trackFlags(trackId)).savedAt).toBeNull();
    expect(await auditCount(trackId, 'unsave')).toBe(1);
    expect((await trackFlags(shared)).savedAt).toEqual(NOW);
    expect((await trackFlags(shared)).favoritedAt).toEqual(NOW);

    expect(await deletePlaylist(testDb.db, { ownerUserId, playlistId: favorites.id })).toBe(
      'system',
    );
  });
});

describe.skipIf(skip)('applyTrackMemberships', () => {
  it('applies the full desired set atomically: adds, removes, inline create, flag sync', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    const a = await createPlaylist(testDb.db, { ownerUserId, name: 'A' });
    const b = await createPlaylist(testDb.db, { ownerUserId, name: 'B' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: a.id,
      trackIds: [trackId],
      now: NOW,
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: favorites.id,
      trackIds: [trackId],
      now: NOW,
    });

    const LATER = new Date('2026-07-23T13:00:00Z');
    const result = await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId,
      playlistIds: [b.id],
      createPlaylistName: 'Road trip',
      now: LATER,
    });
    expect(result).not.toBeNull();
    expect(result).not.toBe('removed');
    if (result === null || result === 'removed') throw new Error('unreachable');
    expect(result.createdPlaylistId).toBeTruthy();
    expect([...result.playlistIds].sort()).toEqual([b.id, result.createdPlaylistId].sort());

    expect(await memberPositions(a.id)).toEqual([]);
    expect(await memberPositions(favorites.id)).toEqual([]);
    expect(await memberPositions(b.id)).toEqual([[trackId, 0]]);
    expect(await memberPositions(result.createdPlaylistId!)).toEqual([[trackId, 0]]);
    const flags = await trackFlags(trackId);
    expect(flags.savedAt).toEqual(NOW); // continuously a member — savedAt keeps its origin
    expect(flags.favoritedAt).toBeNull(); // Favorites unchecked
    expect(await auditCount(trackId, 'unfavorite')).toBe(1);
    expect(await auditCount(trackId, 'unsave')).toBe(0);
  });

  it('an empty desired set is Unsave; unknown/foreign playlist ids are ignored', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const a = await createPlaylist(testDb.db, { ownerUserId, name: 'A' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: a.id,
      trackIds: [trackId],
      now: NOW,
    });

    const other = await createUser(testDb.db);
    const foreign = await createPlaylist(testDb.db, { ownerUserId: other, name: 'Foreign' });

    const result = await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId,
      playlistIds: [foreign.id], // not ours -> ignored -> effectively empty
    });
    if (result === null || result === 'removed') throw new Error('unreachable');
    expect(result.playlistIds).toEqual([]);
    expect((await trackFlags(trackId)).savedAt).toBeNull();
    expect(await auditCount(trackId, 'unsave')).toBe(1);
    expect(await memberPositions(foreign.id)).toEqual([]);
  });

  it('refuses rejected tracks and 404s absent/cross-owner tracks', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    await testDb.pool.query("update tracks set status = 'rejected' where id = $1", [trackId]);
    expect(await applyTrackMemberships(testDb.db, { ownerUserId, trackId, playlistIds: [] })).toBe(
      'removed',
    );

    const other = await createUser(testDb.db);
    const { trackId: foreignTrack } = await seedReadyTrack(testDb.db);
    expect(
      await applyTrackMemberships(testDb.db, {
        ownerUserId: other,
        trackId: foreignTrack,
        playlistIds: [],
      }),
    ).toBeNull();
  });
});

describe.skipIf(skip)('getPlaylistDetail / mosaic cover sources', () => {
  it('returns members in position order with track summaries and pages by position', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const b = await seedSiblingTrack(ownerUserId);
    const c = await seedSiblingTrack(ownerUserId);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Detail' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId, b, c],
      now: NOW,
    });

    const page1 = await getPlaylistDetail(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      limit: 2,
    });
    expect(page1?.playlist.id).toBe(playlist.id);
    expect(page1?.playlist.trackCount).toBe(3);
    expect(page1?.items.map((i) => i.id)).toEqual([trackId, b]);
    expect(page1?.items.map((i) => i.position)).toEqual([0, 1]);
    expect(page1?.items[0]?.savedAt).toEqual(NOW);
    expect(page1?.items[0]?.hasPlayableAudio).toBe(true);
    expect(page1?.nextCursor).not.toBeNull();

    const page2 = await getPlaylistDetail(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      cursor: page1!.nextCursor,
      limit: 2,
    });
    expect(page2?.items.map((i) => i.id)).toEqual([c]);
    expect(page2?.nextCursor).toBeNull();

    // Cross-owner: absent.
    const other = await createUser(testDb.db);
    expect(
      await getPlaylistDetail(testDb.db, {
        ownerUserId: other,
        playlistId: playlist.id,
        limit: 10,
      }),
    ).toBeNull();
  });

  it('derives mosaic tiles from each member’s effective cover — Session Cover over track cover, distinct, in playlist order', async () => {
    const { ownerUserId, sessionId, trackId } = await seedReadyTrack(testDb.db);
    // Second member of the SAME session: shares its Session Cover, so
    // distinctness must collapse the pair into one tile.
    const { trackId: sameSessionTrack } = await seedReadyTrack(testDb.db, {
      ownerUserId,
      sessionId,
    });
    const sessionless = await seedSiblingTrack(ownerUserId);
    const coverless = await seedSiblingTrack(ownerUserId);

    const sessionCoverId = await createCoverImage(testDb.db);
    const trackOwnCoverId = await createCoverImage(testDb.db);
    const shadowedCoverId = await createCoverImage(testDb.db);

    await testDb.pool.query('update activity_sessions set cover_image_id = $1 where id = $2', [
      sessionCoverId,
      sessionId,
    ]);
    // The member row shows coalesce(Session Cover, track cover) — the mosaic
    // must match, so a track's own cover is shadowed by its Session Cover…
    await testDb.pool.query('update tracks set cover_image_id = $1 where id = $2', [
      shadowedCoverId,
      trackId,
    ]);
    // …and stands in only for a Session-less track.
    await testDb.pool.query('update tracks set cover_image_id = $1 where id = $2', [
      trackOwnCoverId,
      sessionless,
    ]);

    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mosaic' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId, sameSessionTrack, sessionless, coverless],
    });

    const listed = await listPlaylists(testDb.db, { ownerUserId });
    const mosaic = listed.find((p) => p.id === playlist.id);
    expect(mosaic?.mosaicCoverImageIds).toEqual([sessionCoverId, trackOwnCoverId]);
  });

  it('reports containsTrack for the picker and soleMemberTrackCount for delete confirms', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const shared = await seedSiblingTrack(ownerUserId);
    const a = await createPlaylist(testDb.db, { ownerUserId, name: 'A' });
    const b = await createPlaylist(testDb.db, { ownerUserId, name: 'B' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: a.id,
      trackIds: [trackId, shared],
    });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: b.id, trackIds: [shared] });

    const withTrack = await listPlaylists(testDb.db, { ownerUserId, containsTrackId: trackId });
    expect(withTrack.find((p) => p.id === a.id)?.containsTrack).toBe(true);
    expect(withTrack.find((p) => p.id === b.id)?.containsTrack).toBe(false);
    // Only trackId is exclusive to A; `shared` also lives in B.
    expect(withTrack.find((p) => p.id === a.id)?.soleMemberTrackCount).toBe(1);
    expect(withTrack.find((p) => p.id === b.id)?.soleMemberTrackCount).toBe(0);

    const withoutTrack = await listPlaylists(testDb.db, { ownerUserId });
    expect(withoutTrack.find((p) => p.id === a.id)?.containsTrack).toBeNull();
  });
});

describe.skipIf(skip)('listPlaylists search', () => {
  it('matches playlist names and member track titles (case-insensitive, literal)', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    await testDb.pool.query('update tracks set title = $1 where id = $2', [
      'Morning Piano',
      trackId,
    ]);
    const beach = await createPlaylist(testDb.db, { ownerUserId, name: 'Beach drive' });
    const workout = await createPlaylist(testDb.db, { ownerUserId, name: 'Workout 100%' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: workout.id,
      trackIds: [trackId],
    });

    async function search(term: string): Promise<string[]> {
      const listed = await listPlaylists(testDb.db, { ownerUserId, search: term });
      return listed.map((p) => p.id).sort();
    }

    expect(await search('beach')).toEqual([beach.id]);
    expect(await search('piano')).toEqual([workout.id]);
    expect(await search('0%')).toEqual([workout.id]);
    expect(await search('xylophone')).toEqual([]);
    expect(await search('  ')).toEqual([beach.id, workout.id].sort());
  });

  it('keeps the playlist surface at name + member titles under the shared matcher', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    // A member whose prompt (a track-surface field) carries a unique word: the
    // playlist surface must not widen to it.
    await testDb.pool.query('update tracks set title = $1, prompt = $2 where id = $3', [
      'Quiet Keys',
      'glacial soundscape study',
      trackId,
    ]);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Evening Wind-down' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
    });

    const byMemberTitle = await listPlaylists(testDb.db, { ownerUserId, search: 'QUIET keys' });
    expect(byMemberTitle.map((p) => p.id)).toEqual([playlist.id]);
    const byMemberPrompt = await listPlaylists(testDb.db, { ownerUserId, search: 'glacial' });
    expect(byMemberPrompt).toEqual([]);
  });

  it('finds a member genre tag typed as the card shows it', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    await testDb.pool.query('update tracks set genre_tags = $1::jsonb where id = $2', [
      JSON.stringify(['deep-house']),
      trackId,
    ]);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Evening Wind-down' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
    });

    const listed = await listPlaylists(testDb.db, { ownerUserId, search: 'deep house' });

    expect(listed.map((p) => p.id)).toEqual([playlist.id]);
  });
});

// `inCuratedPlaylist` is the fact an Add to Playlist affordance may report, where
// `savedAt` may not: the star files a Track into Favorites, which the Playlists
// tab does not list and the save picker does not offer.
describe.skipIf(skip)('curated Playlist membership', () => {
  it('excludes Favorites, on both the track read and the picker’s own commit', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });

    const starred = await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId,
      playlistIds: [favorites.id],
      now: NOW,
    });
    if (starred === null || starred === 'removed') throw new Error('unreachable');
    expect(starred.flags.savedAt).toEqual(NOW);
    expect(starred.inCuratedPlaylist).toBe(false);
    expect(
      (await getOwnedTrackSummary(testDb.db, { ownerUserId, trackId }))?.inCuratedPlaylist,
    ).toBe(false);

    const filed = await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId,
      playlistIds: [favorites.id],
      createPlaylistName: 'Night drive',
      now: NOW,
    });
    if (filed === null || filed === 'removed') throw new Error('unreachable');
    expect(filed.inCuratedPlaylist).toBe(true);
    expect(
      (await getOwnedTrackSummary(testDb.db, { ownerUserId, trackId }))?.inCuratedPlaylist,
    ).toBe(true);
  });
});

describe.skipIf(skip)('membership-backed retention writes', () => {
  it('setTrackFavorited toggles Favorites membership (auto-ensuring the playlist)', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);

    const on = await setTrackFavorited(testDb.db, {
      ownerUserId,
      trackId,
      favorited: true,
      now: NOW,
    });
    if (on === null || on === 'removed') throw new Error('unreachable');
    expect(on.favoritedAt).toEqual(NOW);
    expect(on.savedAt).toEqual(NOW);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    expect(await memberPositions(favorites.id)).toEqual([[trackId, 0]]);

    // Unstar with no other membership: leaves the Library entirely.
    const off = await setTrackFavorited(testDb.db, {
      ownerUserId,
      trackId,
      favorited: false,
    });
    if (off === null || off === 'removed') throw new Error('unreachable');
    expect(off.favoritedAt).toBeNull();
    expect(off.savedAt).toBeNull();
    expect(await memberPositions(favorites.id)).toEqual([]);
    expect(await auditCount(trackId, 'unsave')).toBe(1);

    // Idempotent + refusal semantics preserved.
    expect(await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: false })).not.toBe(
      null,
    );
    await testDb.pool.query("update tracks set status = 'rejected' where id = $1", [trackId]);
    expect(await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true })).toBe(
      'removed',
    );
  });

  it('unsaveTrackEverywhere removes all memberships and returns Ephemeral flags', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const a = await createPlaylist(testDb.db, { ownerUserId, name: 'A' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: a.id, trackIds: [trackId] });
    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true });

    const result = await unsaveTrackEverywhere(testDb.db, { ownerUserId, trackId });
    if (result === null || result === 'removed') throw new Error('unreachable');
    expect(result.savedAt).toBeNull();
    expect(result.favoritedAt).toBeNull();
    expect(result.retentionClass).toBe('ephemeral');
    expect(await memberPositions(a.id)).toEqual([]);
  });
});

describe.skipIf(skip)('concurrent membership writers', () => {
  /**
   * The pool opens connections lazily, so a race whose second writer still has to
   * establish one is staggered by the handshake and never overlaps. Opening both
   * up front is what makes these two writers actually run side by side.
   */
  async function openBothConnections(): Promise<void> {
    await Promise.all([testDb.pool.query('select 1'), testDb.pool.query('select 1')]);
  }

  it('gives two simultaneous favorites of different tracks distinct positions', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const sibling = await seedSiblingTrack(ownerUserId);
    // Pre-create Favorites so both writers run the identical statement sequence
    // and reach the append-slot read together.
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    await openBothConnections();

    await Promise.all([
      setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true }),
      setTrackFavorited(testDb.db, { ownerUserId, trackId: sibling, favorited: true }),
    ]);

    // Two appends computed from the same `max(position)` land on one slot, and a
    // duplicate position is unreachable through the position-keyset detail read:
    // one of the owner's favorites disappears from every page.
    const positions = await memberPositions(favorites.id);
    expect(positions.map(([, position]) => position)).toEqual([0, 1]);
    expect(new Set(positions.map(([track]) => track))).toEqual(new Set([trackId, sibling]));
  });

  it('converges when Add to playlist and the membership picker race the same pair', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Road trip' });
    await openBothConnections();

    // The two writers approached `playlists` and `tracks` from opposite ends, so
    // this pair could deadlock (40P01) and surface as a bare 500.
    const [added, applied] = await Promise.all([
      addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds: [trackId] }),
      applyTrackMemberships(testDb.db, { ownerUserId, trackId, playlistIds: [playlist.id] }),
    ]);

    // Whichever ran first appended; the other saw an existing member. Neither
    // refused, and the track holds exactly one slot.
    expect(added?.refused).toEqual([]);
    expect(applied).toMatchObject({ playlistIds: [playlist.id] });
    expect(await memberPositions(playlist.id)).toEqual([[trackId, 0]]);
  });
});

describe.skipIf(skip)('membership purge on Dislike / Delete Track', () => {
  it('rejectDislikedTrack removes memberships, resequences, and clears retention flags', async () => {
    const { ownerUserId, sessionId, trackId } = await seedReadyTrack(testDb.db);
    const keeper = await seedSiblingTrack(ownerUserId);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'P' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId, keeper],
      now: NOW,
    });

    await rejectDislikedTrack(testDb.db, { ownerUserId, trackId, activitySessionId: sessionId });
    expect(await memberPositions(playlist.id)).toEqual([[keeper, 0]]);
    const flags = await trackFlags(trackId);
    expect(flags.savedAt).toBeNull();
    expect(flags.favoritedAt).toBeNull();
  });

  it('deleteTrack removes memberships and clears retention flags', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true, now: NOW });
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });

    await deleteTrack(testDb.db, { ownerUserId, trackId });
    expect(await memberPositions(favorites.id)).toEqual([]);
    const flags = await trackFlags(trackId);
    expect(flags.savedAt).toBeNull();
    expect(flags.favoritedAt).toBeNull();
  });

  it('tombstoning clears the track cover pointer so the cover stays reclaimable', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const coverImageId = crypto.randomUUID();
    await testDb.pool.query(
      `insert into cover_images (id, source_type, storage_provider, storage_key)
       values ($1, 'generated', 'local-fs', $2)`,
      [coverImageId, `covers/generated/test/${coverImageId}.webp`],
    );
    await testDb.pool.query('update tracks set cover_image_id = $1 where id = $2', [
      coverImageId,
      trackId,
    ]);

    await deleteTrack(testDb.db, { ownerUserId, trackId });

    const row = await testDb.pool.query('select cover_image_id from tracks where id = $1', [
      trackId,
    ]);
    expect(row.rows[0].cover_image_id).toBeNull();
  });
});

// Orphan cleanup: a track whose originating session
// is gone and that loses its LAST membership is deleted immediately — there is
// no surface left that can reach it, so keeping the row/audio would leak both.
describe.skipIf(skip)('orphan cleanup on membership loss', () => {
  /** A ready audio-bearing track with NO living session edge (orphan origin). */
  async function seedSessionlessTrack(ownerUserId: string): Promise<string> {
    const requestId = await createGenerationRequest(testDb.db, { ownerUserId });
    const jobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    return createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      audioStorageKey: `audio/orphan-${crypto.randomUUID()}.mp3`,
    });
  }

  async function trackState(trackId: string) {
    const result = await testDb.pool.query('select status from tracks where id = $1', [trackId]);
    return result.rows[0].status as string;
  }

  async function queuedReasons(trackId: string): Promise<string[]> {
    const result = await testDb.pool.query(
      'select reason from deletion_queue_items where track_id = $1',
      [trackId],
    );
    return result.rows.map((r) => r.reason as string);
  }

  it('removing the last membership of a session-less track deletes it and queues its audio', async () => {
    const ownerUserId = await createUser(testDb.db);
    const trackId = await seedSessionlessTrack(ownerUserId);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Last home' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
      now: NOW,
    });

    await removePlaylistTrack(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackId,
      now: at(1),
    });

    expect(await trackState(trackId)).toBe('deleted');
    expect(await queuedReasons(trackId)).toEqual(['orphan_cleanup']);
    // The unsave audit still lands — the membership loss happened before the cleanup.
    expect(await auditCount(trackId, 'unsave')).toBe(1);
  });

  it('a track whose session still exists returns to Ephemeral and persists', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'P' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
      now: NOW,
    });

    await removePlaylistTrack(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackId,
      now: at(1),
    });

    expect(await trackState(trackId)).toBe('ready');
    expect(await queuedReasons(trackId)).toEqual([]);
  });

  it('a session-less track still in another playlist survives', async () => {
    const ownerUserId = await createUser(testDb.db);
    const trackId = await seedSessionlessTrack(ownerUserId);
    const first = await createPlaylist(testDb.db, { ownerUserId, name: 'First' });
    const second = await createPlaylist(testDb.db, { ownerUserId, name: 'Second' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: first.id,
      trackIds: [trackId],
      now: NOW,
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: second.id,
      trackIds: [trackId],
      now: NOW,
    });

    await removePlaylistTrack(testDb.db, {
      ownerUserId,
      playlistId: first.id,
      trackId,
      now: at(1),
    });

    expect(await trackState(trackId)).toBe('ready');
    expect(await queuedReasons(trackId)).toEqual([]);
  });

  it('deletePlaylist reclaims its sole-membership session-less members', async () => {
    const ownerUserId = await createUser(testDb.db);
    const orphan = await seedSessionlessTrack(ownerUserId);
    const keeper = await seedSessionlessTrack(ownerUserId);
    const doomed = await createPlaylist(testDb.db, { ownerUserId, name: 'Doomed' });
    const haven = await createPlaylist(testDb.db, { ownerUserId, name: 'Haven' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: doomed.id,
      trackIds: [orphan, keeper],
      now: NOW,
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: haven.id,
      trackIds: [keeper],
      now: NOW,
    });

    await deletePlaylist(testDb.db, { ownerUserId, playlistId: doomed.id, now: at(1) });

    expect(await trackState(orphan)).toBe('deleted');
    expect(await queuedReasons(orphan)).toEqual(['orphan_cleanup']);
    expect(await trackState(keeper)).toBe('ready');
    expect(await queuedReasons(keeper)).toEqual([]);
  });

  it('un-favoriting the last membership of a session-less track deletes it', async () => {
    const ownerUserId = await createUser(testDb.db);
    const trackId = await seedSessionlessTrack(ownerUserId);
    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true, now: NOW });

    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: false, now: at(1) });

    expect(await trackState(trackId)).toBe('deleted');
    expect(await queuedReasons(trackId)).toEqual(['orphan_cleanup']);
  });
});

describe.skipIf(skip)('deletePlaylist cover reclaim', () => {
  it('reclaims the playlist’s own uploaded cover (row + queued bytes)', async () => {
    const ownerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Covered' });
    const coverImageId = crypto.randomUUID();
    const storageKey = `covers/uploaded/${ownerUserId}/${coverImageId}.webp`;
    await testDb.pool.query(
      `insert into cover_images (id, source_type, storage_provider, storage_key, provenance)
       values ($1, 'uploaded', 'local-fs', $2, $3)`,
      [coverImageId, storageKey, JSON.stringify({ ownerUserId, playlistId: playlist.id })],
    );
    await testDb.pool.query('update playlists set cover_image_id = $1 where id = $2', [
      coverImageId,
      playlist.id,
    ]);

    await deletePlaylist(testDb.db, { ownerUserId, playlistId: playlist.id, now: at(1) });

    const cover = await testDb.pool.query('select 1 from cover_images where id = $1', [
      coverImageId,
    ]);
    expect(cover.rowCount).toBe(0);
    const queued = await testDb.pool.query(
      'select storage_key from deletion_queue_items where storage_key like $1',
      [`covers/%${coverImageId}%`],
    );
    expect(queued.rows.map((r) => r.storage_key as string).sort()).toEqual(
      [storageKey, `covers/renditions/${coverImageId}-w160.webp`].sort(),
    );
  });

  it('a mosaic playlist (no cover of its own) deletes with nothing queued', async () => {
    const ownerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Bare' });

    await deletePlaylist(testDb.db, { ownerUserId, playlistId: playlist.id, now: at(1) });

    const queued = await testDb.pool.query('select 1 from deletion_queue_items');
    expect(queued.rowCount).toBe(0);
  });
});

// The Lounge share state: a nullable timestamp plus an
// audience — null = Private, set = In Lounge for `everyone` or the
// `selected` Users. Owner-scoped, idempotent, and gated to curated user playlists
// (Favorites and unlisted collections can never be shared).
describe.skipIf(skip)('setPlaylistShared (Lounge share state)', () => {
  it('shares and unshares an owned user playlist, exposing sharedAt in list summaries', async () => {
    const ownerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mixtape' });

    const shared = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
      now: NOW,
    });
    expect(shared).toEqual({ sharedAt: NOW, audience: { kind: 'everyone' } });
    const [summary] = await listPlaylists(testDb.db, { ownerUserId, playlistId: playlist.id });
    expect(summary?.sharedAt).toEqual(NOW);

    const unshared = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: null,
      now: at(1),
    });
    expect(unshared).toEqual({ sharedAt: null, audience: null });
    const [after] = await listPlaylists(testDb.db, { ownerUserId, playlistId: playlist.id });
    expect(after?.sharedAt).toBeNull();
  });

  it('a cross-owner playlistId reads as absent and flips nothing (IDOR posture)', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Private stash' });

    const result = await setPlaylistShared(testDb.db, {
      ownerUserId: otherUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
      now: NOW,
    });

    expect(result).toBeNull();
    const [summary] = await listPlaylists(testDb.db, { ownerUserId, playlistId: playlist.id });
    expect(summary?.sharedAt).toBeNull();
  });

  it('refuses Favorites and unlisted collections (kind gate), at rest and shared alike', async () => {
    const ownerUserId = await createUser(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
    const unlisted = await createPlaylist(testDb.db, { ownerUserId, name: 'Saved tracks' });
    await testDb.pool.query('update playlists set listed_in_playlists = false where id = $1', [
      unlisted.id,
    ]);

    expect(
      await setPlaylistShared(testDb.db, {
        ownerUserId,
        playlistId: favorites.id,
        audience: { kind: 'everyone' },
        now: NOW,
      }),
    ).toBe('system');
    expect(
      await setPlaylistShared(testDb.db, {
        ownerUserId,
        playlistId: unlisted.id,
        audience: { kind: 'everyone' },
        now: NOW,
      }),
    ).toBe('system');
    const shared = await testDb.pool.query('select 1 from playlists where shared_at is not null');
    expect(shared.rowCount).toBe(0);
  });

  it('re-sharing keeps the original sharedAt (the newest-first Lounge sort key must not bump)', async () => {
    const ownerUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Steady' });

    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
      now: NOW,
    });
    const again = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
      now: at(5),
    });
    expect(again).toEqual({ sharedAt: NOW, audience: { kind: 'everyone' } });

    // Unsharing a Private playlist is likewise a no-op, not an error.
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: null,
      now: at(6),
    });
    const twice = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: null,
      now: at(7),
    });
    expect(twice).toEqual({ sharedAt: null, audience: null });
  });

  it('shares with picked Users, storing only real Users other than the owner', async () => {
    const ownerUserId = await createUser(testDb.db);
    const mira = await createUser(testDb.db, { id: 'user-mira' });
    const jonas = await createUser(testDb.db, { id: 'user-jonas' });
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'For two' });

    const shared = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'selected', userIds: [jonas, ownerUserId, 'user-ghost', mira, mira] },
      now: NOW,
    });

    expect(shared).toEqual({
      sharedAt: NOW,
      audience: { kind: 'selected', userIds: [jonas, mira].sort() },
    });
    expect(await getPlaylistShare(testDb.db, { ownerUserId, playlistId: playlist.id })).toEqual(
      expect.objectContaining({ audience: { kind: 'selected', userIds: [jonas, mira].sort() } }),
    );
  });

  it('changing the audience of a shared playlist keeps its sharedAt', async () => {
    const ownerUserId = await createUser(testDb.db);
    const mira = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Steady' });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
      now: NOW,
    });

    const narrowed = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'selected', userIds: [mira] },
      now: at(5),
    });
    expect(narrowed).toEqual({ sharedAt: NOW, audience: { kind: 'selected', userIds: [mira] } });

    const widened = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
      now: at(6),
    });
    expect(widened).toEqual({ sharedAt: NOW, audience: { kind: 'everyone' } });
  });

  it('refuses a selected audience with no valid User and leaves the share state as it was', async () => {
    const ownerUserId = await createUser(testDb.db);
    const mira = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Duo' });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'selected', userIds: [mira] },
      now: NOW,
    });

    const refused = await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'selected', userIds: [ownerUserId, 'user-ghost'] },
      now: at(1),
    });

    expect(refused).toBe('empty_audience');
    expect(await getPlaylistShare(testDb.db, { ownerUserId, playlistId: playlist.id })).toEqual(
      expect.objectContaining({ audience: { kind: 'selected', userIds: [mira] } }),
    );
  });

  it('returning to Private forgets the picked Users', async () => {
    const ownerUserId = await createUser(testDb.db);
    const mira = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Duo' });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'selected', userIds: [mira] },
      now: NOW,
    });

    await setPlaylistShared(testDb.db, { ownerUserId, playlistId: playlist.id, audience: null });

    expect(await getPlaylistShare(testDb.db, { ownerUserId, playlistId: playlist.id })).toEqual(
      expect.objectContaining({ audience: null }),
    );
    const rows = await testDb.pool.query('select 1 from playlist_share_members');
    expect(rows.rowCount).toBe(0);
  });
});

describe.skipIf(skip)('getPlaylistShare (the share picker read)', () => {
  it('lists every other User as a candidate, display-name ordered, never the owner', async () => {
    const ownerUserId = await createUser(testDb.db);
    const zed = await createUser(testDb.db);
    const anna = await createUser(testDb.db);
    await testDb.pool.query('update "user" set name = $1 where id = $2', ['Zed', zed]);
    await testDb.pool.query('update "user" set name = $1, image = $2 where id = $3', [
      'Anna',
      '/api/avatar/anna',
      anna,
    ]);
    await testDb.pool.query(
      'insert into listener_profiles (owner_user_id, artist_name) values ($1, $2)',
      [zed, 'Aardvark'],
    );
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Mine' });

    const share = await getPlaylistShare(testDb.db, { ownerUserId, playlistId: playlist.id });

    expect(share).toEqual({
      audience: null,
      candidates: [
        { userId: zed, name: 'Zed', artistName: 'Aardvark', imageUrl: null },
        { userId: anna, name: 'Anna', artistName: null, imageUrl: '/api/avatar/anna' },
      ],
    });
  });

  it('a cross-owner playlistId reads as absent', async () => {
    const ownerUserId = await createUser(testDb.db);
    const otherUserId = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name: 'Private stash' });

    expect(
      await getPlaylistShare(testDb.db, { ownerUserId: otherUserId, playlistId: playlist.id }),
    ).toBeNull();
  });
});

describe.skipIf(skip)('a failed Track (its final never arrived)', () => {
  /** A Track saved into `Mix` and Favorites before its job failed. */
  async function savedThenFailed() {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const mix = await createPlaylist(testDb.db, { ownerUserId, name: 'Mix' });
    const other = await createPlaylist(testDb.db, { ownerUserId, name: 'Other' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: mix.id, trackIds: [trackId] });
    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true });
    await testDb.pool.query("update tracks set status = 'failed' where id = $1", [trackId]);
    return { ownerUserId, trackId, mix, other };
  }

  it('cannot be newly added to a Playlist or favorited, and keeps its memberships', async () => {
    const { ownerUserId, trackId, mix, other } = await savedThenFailed();
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });

    const added = await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: other.id,
      trackIds: [trackId],
    });
    expect(added).toEqual({ added: [], refused: [trackId] });
    expect(
      await applyTrackMemberships(testDb.db, {
        ownerUserId,
        trackId,
        playlistIds: [mix.id, favorites.id, other.id],
      }),
    ).toBe('removed');
    expect(await memberPositions(other.id)).toEqual([]);
    expect(await memberPositions(mix.id)).toEqual([[trackId, 0]]);
    expect(await memberPositions(favorites.id)).toEqual([[trackId, 0]]);
  });

  it('can still be unfavorited, unfiled and removed from a Playlist by its owner', async () => {
    const { ownerUserId, trackId, mix } = await savedThenFailed();
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });

    const unstarred = await setTrackFavorited(testDb.db, {
      ownerUserId,
      trackId,
      favorited: false,
    });
    expect(unstarred).not.toBe('removed');
    expect(await memberPositions(favorites.id)).toEqual([]);
    expect(await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true })).toBe(
      'removed',
    );

    const second = await createPlaylist(testDb.db, { ownerUserId, name: 'Second' });
    await testDb.pool.query(
      'insert into playlist_tracks (playlist_id, track_id, position) values ($1, $2, 0)',
      [second.id, trackId],
    );
    const unfiled = await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId,
      playlistIds: [mix.id],
    });
    expect(unfiled).not.toBe('removed');
    expect(await memberPositions(second.id)).toEqual([]);

    expect(
      await removePlaylistTrack(testDb.db, { ownerUserId, playlistId: mix.id, trackId }),
    ).toEqual({ removed: true, unsaved: true });
  });
});
