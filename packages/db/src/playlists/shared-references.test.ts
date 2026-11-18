import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  addPlaylistTracks,
  applyTrackMemberships,
  createPlaylist,
  deletePlaylist,
  ensureFavoritesPlaylist,
  getPlaylistDetail,
  listPlaylists,
  removePlaylistTrack,
  setPlaylistOrder,
  setTrackFavorited,
} from './playlists-repo';
import { setPlaylistShared } from './playlist-share-repo';
import { getLoungePlaylistDetail } from './lounge-repo';
import { deleteTrack } from '../generation/delete-track-repo';
import { getOwnedTrackSummary } from '../generation/feedback-repo';

// Shared references: a Visitor files a foreign Lounge-audible track
// into their OWN playlists — an ordinary membership row pointing at the owner's
// track. The save authorizes on the one audibility predicate (owner OR
// Lounge-audible) and must leave the owner's state completely untouched:
// `savedAt`/`favoritedAt` derive from the track owner's own memberships only,
// and the feedback audit trail stays owner-scoped.

const skip = !TEST_DATABASE_URL;

const TABLES = ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES] as const;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('shared-references-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

/** An owner whose track sits in one In-Lounge playlist (Lounge-audible). */
async function seedAudibleForeignTrack(): Promise<{
  ownerUserId: string;
  sessionId: string;
  sharedPlaylistId: string;
  trackId: string;
}> {
  const { ownerUserId, sessionId, trackId } = await seedReadyTrack(testDb.db);
  const shared = await createPlaylist(testDb.db, { ownerUserId, name: 'Shared shelf' });
  await addPlaylistTracks(testDb.db, {
    ownerUserId,
    playlistId: shared.id,
    trackIds: [trackId],
  });
  await setPlaylistShared(testDb.db, {
    ownerUserId,
    playlistId: shared.id,
    audience: { kind: 'everyone' },
  });
  return { ownerUserId, sessionId, sharedPlaylistId: shared.id, trackId };
}

async function ownerTrackFlags(trackId: string) {
  const result = await testDb.pool.query(
    'select saved_at, favorited_at from tracks where id = $1',
    [trackId],
  );
  return { savedAt: result.rows[0].saved_at, favoritedAt: result.rows[0].favorited_at };
}

async function memberRows(playlistId: string): Promise<Array<[string, number]>> {
  const result = await testDb.pool.query(
    'select track_id, position from playlist_tracks where playlist_id = $1 order by position',
    [playlistId],
  );
  return result.rows.map((r) => [r.track_id, r.position]);
}

async function feedbackEventCount(trackId: string): Promise<number> {
  const result = await testDb.pool.query(
    'select count(*)::int as n from feedback_events where track_id = $1',
    [trackId],
  );
  return result.rows[0].n as number;
}

describe.skipIf(skip)('Shared reference save', () => {
  it('files a foreign Lounge-audible track into the visitor playlist as an ordinary member, idempotently', async () => {
    const { trackId } = await seedAudibleForeignTrack();
    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My mixtape' });
    const own = await seedReadyTrack(testDb.db, { ownerUserId: visitor });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: visitor,
      playlistId: mine.id,
      trackIds: [own.trackId],
    });

    const ownerFlagsBefore = await ownerTrackFlags(trackId);
    const auditBefore = await feedbackEventCount(trackId);

    const result = await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });
    expect(result).not.toBeNull();
    expect(result).not.toBe('removed');
    if (result === null || typeof result === 'string') throw new Error('unreachable');
    expect(result.playlistIds).toEqual([mine.id]);
    // The reference appends like any other member: dense positions, user order.
    expect(await memberRows(mine.id)).toEqual([
      [own.trackId, 0],
      [trackId, 1],
    ]);
    // The returned shelves are the VISITOR's relationship to the track, never
    // the owner's flags: saved into one non-Favorites playlist. A real Date —
    // the raw membership aggregate must decode like a column read (the route
    // calls `.toISOString()` on it).
    expect(result.flags.savedAt).toBeInstanceOf(Date);
    expect(result.flags.favoritedAt).toBeNull();
    expect(result.flags.dislikedAt).toBeNull();
    expect(result.inCuratedPlaylist).toBe(true);

    // Denormalization guard: the owner's flags derive from the owner's own
    // memberships only, and the audit trail stays owner-scoped.
    expect(await ownerTrackFlags(trackId)).toEqual(ownerFlagsBefore);
    expect(await feedbackEventCount(trackId)).toBe(auditBefore);

    // Idempotent per playlist: re-committing the same set adds nothing.
    const again = await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });
    expect(again).not.toBeNull();
    expect(await memberRows(mine.id)).toEqual([
      [own.trackId, 0],
      [trackId, 1],
    ]);
  });

  it('lets the visitor reorder and remove a reference like any other member of their playlist', async () => {
    const { trackId } = await seedAudibleForeignTrack();
    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My mixtape' });
    const own = await seedReadyTrack(testDb.db, { ownerUserId: visitor });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: visitor,
      playlistId: mine.id,
      trackIds: [own.trackId],
    });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });

    const reordered = await setPlaylistOrder(testDb.db, {
      ownerUserId: visitor,
      playlistId: mine.id,
      trackIds: [trackId, own.trackId],
    });
    expect(reordered).toEqual({ trackIds: [trackId, own.trackId] });
    expect(await memberRows(mine.id)).toEqual([
      [trackId, 0],
      [own.trackId, 1],
    ]);

    // Removing the reference is the visitor's own curation; the owner's track
    // is untouched.
    const removed = await removePlaylistTrack(testDb.db, {
      ownerUserId: visitor,
      playlistId: mine.id,
      trackId,
    });
    expect(removed?.removed).toBe(true);
    expect(await memberRows(mine.id)).toEqual([[own.trackId, 0]]);
    // That was the visitor's LAST reference to the track: `unsaved` speaks for
    // THEIR library (the owner's own memberships must not mask the exit).
    expect(removed?.unsaved).toBe(true);
  });

  it('keeps unsaved false while another of the visitor’s playlists still holds the reference', async () => {
    const { trackId } = await seedAudibleForeignTrack();
    const visitor = await createUser(testDb.db);
    const first = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'First' });
    const second = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Second' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [first.id, second.id],
    });

    const removed = await removePlaylistTrack(testDb.db, {
      ownerUserId: visitor,
      playlistId: first.id,
      trackId,
    });
    expect(removed).toEqual({ removed: true, unsaved: false, deletedForGood: false });
  });

  it('a reference never lights the owner’s In a Playlist', async () => {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Mine' });
    await testDb.pool.query(
      'insert into playlist_tracks (playlist_id, track_id, position) values ($1, $2, 0)',
      [mine.id, trackId],
    );

    const summary = await getOwnedTrackSummary(testDb.db, { ownerUserId, trackId });
    expect(summary?.inCuratedPlaylist).toBe(false);
  });

  it('refuses a foreign track that is not Lounge-audible — indistinguishable from missing', async () => {
    // A private foreign track: in a playlist, but the playlist is not In Lounge.
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const stash = await createPlaylist(testDb.db, { ownerUserId, name: 'Private stash' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: stash.id,
      trackIds: [trackId],
    });

    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My mixtape' });

    const refused = await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });
    expect(refused).toBeNull();
    expect(await memberRows(mine.id)).toEqual([]);
  });

  it('favorites a foreign audible track into the visitor Favorites without touching the owner star', async () => {
    const { trackId } = await seedAudibleForeignTrack();
    const visitor = await createUser(testDb.db);

    const result = await setTrackFavorited(testDb.db, {
      ownerUserId: visitor,
      trackId,
      favorited: true,
    });
    expect(result).not.toBeNull();
    expect(result).not.toBe('removed');
    if (result === null || typeof result === 'string') throw new Error('unreachable');
    expect(result.favoritedAt).not.toBeNull();

    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId: visitor });
    expect(await memberRows(favorites.id)).toEqual([[trackId, 0]]);
    // The owner's own star stays untouched by a visitor's act.
    expect((await ownerTrackFlags(trackId)).favoritedAt).toBeNull();

    const cleared = await setTrackFavorited(testDb.db, {
      ownerUserId: visitor,
      trackId,
      favorited: false,
    });
    if (cleared === null || typeof cleared === 'string') throw new Error('unreachable');
    expect(cleared.favoritedAt).toBeNull();
    expect(await memberRows(favorites.id)).toEqual([]);
  });
});

describe.skipIf(skip)('Shared reference reads', () => {
  it('attributes foreign rows in the visitor playlist detail and serves the visitor shelves, never the owner flags', async () => {
    const { ownerUserId, trackId } = await seedAudibleForeignTrack();
    // Light the owner's own star so a flag leak is detectable.
    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true });
    await testDb.pool.query('update "user" set name = $1, image = $2 where id = $3', [
      'Mira Marlowe',
      '/api/avatar/00000000-0000-4000-8000-00000000aaaa',
      ownerUserId,
    ]);
    await testDb.pool.query(
      'insert into listener_profiles (owner_user_id, artist_name) values ($1, $2)',
      [ownerUserId, 'Nightowl'],
    );

    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My mixtape' });
    const own = await seedReadyTrack(testDb.db, { ownerUserId: visitor });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: visitor,
      playlistId: mine.id,
      trackIds: [own.trackId],
    });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });

    const detail = await getPlaylistDetail(testDb.db, {
      ownerUserId: visitor,
      playlistId: mine.id,
      limit: 10,
    });
    const [ownRow, foreignRow] = detail!.items;
    // The visitor's own member stays unattributed; the reference names its owner.
    expect(ownRow!.owner ?? null).toBeNull();
    expect(foreignRow!.owner).toEqual({
      name: 'Mira Marlowe',
      artistName: 'Nightowl',
      imageUrl: '/api/avatar/00000000-0000-4000-8000-00000000aaaa',
    });
    // The reference's shelves are the VISITOR's relationship: saved (this
    // membership), not favorited — the owner's lit star must not travel. A
    // real Date: raw CASE columns must decode like column reads.
    expect(foreignRow!.savedAt).toBeInstanceOf(Date);
    expect(foreignRow!.favoritedAt).toBeNull();
    expect(foreignRow!.dislikedAt).toBeNull();
    expect(foreignRow!.inCuratedPlaylist).toBe(true);
  });

  it('serves the visitor their own shelves on the Lounge detail once they saved the track', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    await setTrackFavorited(testDb.db, { ownerUserId, trackId, favorited: true });

    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My mixtape' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });

    const detail = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: sharedPlaylistId,
      limit: 10,
    });
    // Saved into the visitor's mixtape; the owner's favorite never travels.
    expect(detail!.items[0]!.savedAt).not.toBeNull();
    expect(detail!.items[0]!.favoritedAt).toBeNull();
    expect(detail!.items[0]!.inCuratedPlaylist).toBe(true);
  });

  it('counts sole members per playlist owner, so a reference never hides a Library exit on delete', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My mixtape' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });

    // Each side holds the track in exactly one of its OWN playlists: deleting
    // either playlist takes the track out of that owner's Library.
    const ownerRows = await listPlaylists(testDb.db, { ownerUserId });
    expect(ownerRows.find((p) => p.id === sharedPlaylistId)?.soleMemberTrackCount).toBe(1);
    const visitorRows = await listPlaylists(testDb.db, { ownerUserId: visitor });
    expect(visitorRows.find((p) => p.id === mine.id)?.soleMemberTrackCount).toBe(1);
  });

  it('never counts a Shared reference among the Tracks a delete removes for good', async () => {
    const { ownerUserId, sessionId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    // The owner's track loses its Session: only the owner's own delete could reclaim it.
    await testDb.pool.query('delete from activity_sessions where id = $1', [sessionId]);
    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My mixtape' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [mine.id],
    });

    const ownerRows = await listPlaylists(testDb.db, { ownerUserId });
    expect(ownerRows.find((p) => p.id === sharedPlaylistId)?.soleMemberDeletedTrackCount).toBe(1);
    const visitorRows = await listPlaylists(testDb.db, { ownerUserId: visitor });
    expect(visitorRows.find((p) => p.id === mine.id)?.soleMemberDeletedTrackCount).toBe(0);
  });
});

/** A visitor holding the foreign track in a mixtape (with an own track ahead
 *  of it) AND in Favorites — the two reference shapes every purge must reach. */
async function seedVisitorReferences(trackId: string): Promise<{
  visitorUserId: string;
  mixtapeId: string;
  favoritesId: string;
  ownTrackId: string;
}> {
  const visitorUserId = await createUser(testDb.db);
  const mixtape = await createPlaylist(testDb.db, { ownerUserId: visitorUserId, name: 'Mixtape' });
  const own = await seedReadyTrack(testDb.db, { ownerUserId: visitorUserId });
  await addPlaylistTracks(testDb.db, {
    ownerUserId: visitorUserId,
    playlistId: mixtape.id,
    trackIds: [own.trackId],
  });
  await applyTrackMemberships(testDb.db, {
    ownerUserId: visitorUserId,
    trackId,
    playlistIds: [mixtape.id],
  });
  await setTrackFavorited(testDb.db, { ownerUserId: visitorUserId, trackId, favorited: true });
  const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId: visitorUserId });
  return {
    visitorUserId,
    mixtapeId: mixtape.id,
    favoritesId: favorites.id,
    ownTrackId: own.trackId,
  };
}

describe.skipIf(skip)('Revocation purge', () => {
  it('unshare purges every reference in the same transaction and re-share does not restore them', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const refs = await seedVisitorReferences(trackId);

    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      audience: null,
    });

    // Both reference shapes are hard-removed; the visitor's own member closes
    // the gap (dense positions) and the owner's playlist is untouched.
    expect(await memberRows(refs.mixtapeId)).toEqual([[refs.ownTrackId, 0]]);
    expect(await memberRows(refs.favoritesId)).toEqual([]);
    expect(await memberRows(sharedPlaylistId)).toEqual([[trackId, 0]]);

    // Re-sharing is a NEW license: the purged references stay gone (re-save).
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      audience: { kind: 'everyone' },
    });
    expect(await memberRows(refs.mixtapeId)).toEqual([[refs.ownTrackId, 0]]);
    expect(await memberRows(refs.favoritesId)).toEqual([]);
  });

  it('unshare keeps references to tracks still audible via another In-Lounge playlist', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const second = await createPlaylist(testDb.db, { ownerUserId, name: 'Second shelf' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: second.id,
      trackIds: [trackId],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: second.id,
      audience: { kind: 'everyone' },
    });
    const refs = await seedVisitorReferences(trackId);

    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      audience: null,
    });

    expect(await memberRows(refs.mixtapeId)).toEqual([
      [refs.ownTrackId, 0],
      [trackId, 1],
    ]);
    expect(await memberRows(refs.favoritesId)).toEqual([[trackId, 0]]);
  });

  it('deleting the sharing playlist purges the references', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const refs = await seedVisitorReferences(trackId);

    await deletePlaylist(testDb.db, { ownerUserId, playlistId: sharedPlaylistId });

    expect(await memberRows(refs.mixtapeId)).toEqual([[refs.ownTrackId, 0]]);
    expect(await memberRows(refs.favoritesId)).toEqual([]);
  });

  it('removing a track from its last sharing playlist purges its references; a still-shared sibling keeps them', async () => {
    const { ownerUserId, sessionId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    // A sibling track in the same shared playlist stays audible throughout.
    const sibling = await seedReadyTrack(testDb.db, { ownerUserId, sessionId });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      trackIds: [sibling.trackId],
    });
    // Keep the removed track saved for the owner elsewhere, so the purge is
    // provably about audibility, not the owner's retention.
    const keep = await createPlaylist(testDb.db, { ownerUserId, name: 'Private keep' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: keep.id,
      trackIds: [trackId],
    });
    const refs = await seedVisitorReferences(trackId);
    await applyTrackMemberships(testDb.db, {
      ownerUserId: refs.visitorUserId,
      trackId: sibling.trackId,
      playlistIds: [refs.mixtapeId],
    });

    await removePlaylistTrack(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      trackId,
    });

    // The removed track's references die; the sibling's survive untouched.
    expect(await memberRows(refs.mixtapeId)).toEqual([
      [refs.ownTrackId, 0],
      [sibling.trackId, 1],
    ]);
    expect(await memberRows(refs.favoritesId)).toEqual([]);
    // The owner keeps their own membership and Saved state.
    expect(await memberRows(keep.id)).toEqual([[trackId, 0]]);
    expect((await ownerTrackFlags(trackId)).savedAt).not.toBeNull();
  });

  it('the owner unfiling the shared playlist through the picker purges the references too', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const keep = await createPlaylist(testDb.db, { ownerUserId, name: 'Private keep' });
    const refs = await seedVisitorReferences(trackId);

    // The picker commit rewrites the whole membership set: shared playlist out,
    // a private one in — the track stays saved but stops being audible.
    await applyTrackMemberships(testDb.db, {
      ownerUserId,
      trackId,
      playlistIds: [keep.id],
    });

    expect(await memberRows(refs.mixtapeId)).toEqual([[refs.ownTrackId, 0]]);
    expect(await memberRows(refs.favoritesId)).toEqual([]);
    expect(await memberRows(sharedPlaylistId)).toEqual([]);
    expect(await memberRows(keep.id)).toEqual([[trackId, 0]]);
  });

  it('moving the track between two In-Lounge playlists in one picker commit keeps the references', async () => {
    const { ownerUserId, trackId } = await seedAudibleForeignTrack();
    const second = await createPlaylist(testDb.db, { ownerUserId, name: 'Second shelf' });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: second.id,
      audience: { kind: 'everyone' },
    });
    const refs = await seedVisitorReferences(trackId);

    await applyTrackMemberships(testDb.db, { ownerUserId, trackId, playlistIds: [second.id] });

    expect(await memberRows(refs.mixtapeId)).toEqual([
      [refs.ownTrackId, 0],
      [trackId, 1],
    ]);
    expect(await memberRows(refs.favoritesId)).toEqual([[trackId, 0]]);
  });

  it('a visitor save waiting on the revoking commit refuses the track instead of filing it', async () => {
    const { sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Mine' });

    // The owner's revocation holds the track row lock, as every revoking write does.
    const owner = await testDb.pool.connect();
    let save: ReturnType<typeof applyTrackMemberships> | undefined;
    try {
      await owner.query('begin');
      await owner.query('select id from tracks where id = $1 for update', [trackId]);
      await owner.query('update playlists set shared_at = null where id = $1', [sharedPlaylistId]);
      save = applyTrackMemberships(testDb.db, {
        ownerUserId: visitor,
        trackId,
        playlistIds: [mine.id],
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await owner.query('commit');
    } finally {
      owner.release();
    }

    expect(await save).toBeNull();
    expect(await memberRows(mine.id)).toEqual([]);
  });

  it('unshare waits for a visitor save in flight and purges the reference it commits', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const visitor = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Mine' });

    // The visitor's save has locked the track and filed it, not yet committed.
    const save = await testDb.pool.connect();
    let unshare: ReturnType<typeof setPlaylistShared> | undefined;
    try {
      await save.query('begin');
      await save.query('select id from tracks where id = $1 for update', [trackId]);
      await save.query(
        'insert into playlist_tracks (playlist_id, track_id, position) values ($1, $2, 0)',
        [mine.id, trackId],
      );
      unshare = setPlaylistShared(testDb.db, {
        ownerUserId,
        playlistId: sharedPlaylistId,
        audience: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await save.query('commit');
    } finally {
      save.release();
    }

    await unshare;
    expect(await memberRows(mine.id)).toEqual([]);
  });

  it('deleting the track reaches the foreign references (the existing cross-playlist purge)', async () => {
    const { ownerUserId, trackId } = await seedAudibleForeignTrack();
    const refs = await seedVisitorReferences(trackId);

    const result = await deleteTrack(testDb.db, { ownerUserId, trackId });
    expect(result).not.toBeNull();

    expect(await memberRows(refs.mixtapeId)).toEqual([[refs.ownTrackId, 0]]);
    expect(await memberRows(refs.favoritesId)).toEqual([]);
  });

  it('deleting the owner cascades every reference away', async () => {
    const { ownerUserId, trackId } = await seedAudibleForeignTrack();
    const refs = await seedVisitorReferences(trackId);

    await testDb.pool.query('delete from "user" where id = $1', [ownerUserId]);

    const remaining = await testDb.pool.query('select 1 from playlist_tracks where track_id = $1', [
      trackId,
    ]);
    expect(remaining.rowCount).toBe(0);
    // The visitor's own material survives.
    expect((await memberRows(refs.mixtapeId)).map(([id]) => id)).toEqual([refs.ownTrackId]);
  });
});

// A `selected` audience: audibility is per visitor, so
// narrowing who a playlist reaches revokes exactly the Users it drops.
describe.skipIf(skip)('Revocation purge under a selected audience', () => {
  it('narrowing the audience purges the dropped visitor’s references and keeps the remaining one’s', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const kept = await seedVisitorReferences(trackId);
    const dropped = await seedVisitorReferences(trackId);

    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      audience: { kind: 'selected', userIds: [kept.visitorUserId] },
    });

    expect(await memberRows(kept.mixtapeId)).toEqual([
      [kept.ownTrackId, 0],
      [trackId, 1],
    ]);
    expect(await memberRows(kept.favoritesId)).toEqual([[trackId, 0]]);
    expect(await memberRows(dropped.mixtapeId)).toEqual([[dropped.ownTrackId, 0]]);
    expect(await memberRows(dropped.favoritesId)).toEqual([]);
  });

  it('a reference survives narrowing while another playlist of the owner still reaches its holder', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const refs = await seedVisitorReferences(trackId);
    const duo = await createPlaylist(testDb.db, { ownerUserId, name: 'Duo' });
    await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: duo.id, trackIds: [trackId] });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: duo.id,
      audience: { kind: 'selected', userIds: [refs.visitorUserId] },
    });

    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      audience: null,
    });

    expect(await memberRows(refs.favoritesId)).toEqual([[trackId, 0]]);
  });

  it('a visitor outside the audience cannot save the track at all', async () => {
    const { ownerUserId, sharedPlaylistId, trackId } = await seedAudibleForeignTrack();
    const insider = await createUser(testDb.db);
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: sharedPlaylistId,
      audience: { kind: 'selected', userIds: [insider] },
    });
    const outsider = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: outsider, name: 'Mine' });

    const result = await applyTrackMemberships(testDb.db, {
      ownerUserId: outsider,
      trackId,
      playlistIds: [mine.id],
    });

    expect(result).toBeNull();
    expect(await memberRows(mine.id)).toEqual([]);
  });
});
