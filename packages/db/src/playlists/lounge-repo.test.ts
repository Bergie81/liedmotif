import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createCoverImage,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { getLoungePlaylistDetail, listLoungePlaylistsPage, listLoungeSharers } from './lounge-repo';
import type { ShareAudience } from '@liedmotif/shared';
import {
  addPlaylistTracks,
  applyTrackMemberships,
  createPlaylist,
  removePlaylistTrack,
} from './playlists-repo';
import { setPlaylistLoungePinned } from './pins-repo';
import { setPlaylistShared } from './playlist-share-repo';

// The Lounge listing: every non-empty playlist in the
// Lounge for the viewer — shared with everyone, or with them by name — across
// all owners, attributed, the viewer's Pins first (newest pin first), then
// newest-shared first. The viewer's own shares appear like everyone else's
// ("Yours" is the route's presentation, not a filter).

const skip = !TEST_DATABASE_URL;
const NOW = new Date('2026-08-12T12:00:00Z');

/** A fixed-clock timestamp `minutes` after NOW. */
function at(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

const TABLES = [
  'playlist_pins',
  'playlist_tracks',
  'playlists',
  'cover_images',
  ...GENERATION_FIXTURE_TABLES,
] as const;

let testDb: TestDb;
/** A User with no shares of their own, reading the Lounge. */
let bystander: string;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('lounge-repo-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
  bystander = await createUser(testDb.db);
});

/** One owner with a shared, track-bearing playlist; returns all three ids. */
async function seedSharedPlaylist(args: {
  name: string;
  sharedAt: Date;
  ownerUserId?: string;
  sessionId?: string;
  trackTitle?: string;
  genreTags?: string[];
  lyrics?: string;
  audience?: ShareAudience;
}): Promise<{ ownerUserId: string; sessionId: string; playlistId: string; trackId: string }> {
  const { ownerUserId, sessionId, trackId } = await seedReadyTrack(testDb.db, {
    ownerUserId: args.ownerUserId,
    sessionId: args.sessionId,
  });
  await testDb.pool.query(
    'update tracks set title = $1, genre_tags = $2, lyrics = $3 where id = $4',
    [args.trackTitle ?? null, JSON.stringify(args.genreTags ?? []), args.lyrics ?? null, trackId],
  );
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name: args.name });
  await addPlaylistTracks(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    trackIds: [trackId],
  });
  await setPlaylistShared(testDb.db, {
    ownerUserId,
    playlistId: playlist.id,
    audience: args.audience ?? { kind: 'everyone' },
    now: args.sharedAt,
  });
  return { ownerUserId, sessionId, playlistId: playlist.id, trackId };
}

describe.skipIf(skip)('listLoungePlaylistsPage', () => {
  it('lists In-Lounge playlists across all owners with attribution; private ones stay invisible', async () => {
    const mira = await seedSharedPlaylist({ name: 'Rainy Balcony Tapes', sharedAt: NOW });
    const jonas = await seedSharedPlaylist({ name: 'Kitchen Discotheque', sharedAt: at(1) });
    // A third owner's non-empty PRIVATE playlist must never surface.
    const { ownerUserId: hermit, trackId } = await seedReadyTrack(testDb.db);
    const stash = await createPlaylist(testDb.db, { ownerUserId: hermit, name: 'Private stash' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: hermit,
      playlistId: stash.id,
      trackIds: [trackId],
    });

    await testDb.pool.query('update "user" set name = $1, image = $2 where id = $3', [
      'Mira Marlowe',
      '/api/avatar/00000000-0000-4000-8000-00000000aaaa',
      mira.ownerUserId,
    ]);
    await testDb.pool.query(
      'insert into listener_profiles (owner_user_id, artist_name) values ($1, $2)',
      [mira.ownerUserId, 'Nightowl'],
    );

    const page = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([jonas.playlistId, mira.playlistId]);
    expect(page.nextCursor).toBeNull();

    const attributed = page.items.find((item) => item.id === mira.playlistId)!;
    expect(attributed.owner).toEqual({
      userId: mira.ownerUserId,
      name: 'Mira Marlowe',
      artistName: 'Nightowl',
      imageUrl: '/api/avatar/00000000-0000-4000-8000-00000000aaaa',
    });
    expect(attributed.trackCount).toBe(1);
    expect(attributed.sharedAt).toEqual(NOW);

    // No listener_profiles row: the artist name reads null (the first-name
    // fallback is presentation), and a missing avatar reads null.
    const bare = page.items.find((item) => item.id === jonas.playlistId)!;
    expect(bare.owner.artistName).toBeNull();
    expect(bare.owner.imageUrl).toBeNull();
  });

  it('excludes empty In-Lounge playlists from the listing without touching their share state', async () => {
    await seedSharedPlaylist({ name: 'Has tracks', sharedAt: NOW });
    const ownerUserId = await createUser(testDb.db);
    const empty = await createPlaylist(testDb.db, { ownerUserId, name: 'Dead entry' });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: empty.id,
      audience: { kind: 'everyone' },
      now: at(1),
    });

    const page = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 10 });
    expect(page.items.map((item) => item.name)).toEqual(['Has tracks']);

    // Unlisted, not unshared: the owner's share state survives untouched.
    const row = await testDb.pool.query('select shared_at from playlists where id = $1', [
      empty.id,
    ]);
    expect(row.rows[0].shared_at).toEqual(at(1));
  });

  it('summarizes each entry with member playtime and mosaic sources for the tile', async () => {
    const { ownerUserId, playlistId } = await seedSharedPlaylist({ name: 'Timed', sharedAt: NOW });
    const [member] = (
      await testDb.pool.query('select track_id from playlist_tracks where playlist_id = $1', [
        playlistId,
      ])
    ).rows;
    await testDb.pool.query('update tracks set duration_seconds = 245 where id = $1', [
      member.track_id,
    ]);
    // The playlist's own uploaded cover wins over the mosaic, same as the
    // owner's grid (the tile reuses the one PlaylistCover precedence).
    const coverId = crypto.randomUUID();
    await testDb.pool.query(
      `insert into cover_images (id, source_type, storage_provider, storage_key)
       values ($1, 'uploaded', 'local-fs', $2)`,
      [coverId, `covers/uploaded/${ownerUserId}/${coverId}.webp`],
    );
    await testDb.pool.query('update playlists set cover_image_id = $1 where id = $2', [
      coverId,
      playlistId,
    ]);

    const page = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 10 });
    expect(page.items[0]?.totalDurationSeconds).toBe(245);
    expect(page.items[0]?.coverImageId).toBe(coverId);
  });

  it('matches playlist name, owner names, member track titles and genre tags — each naming its winning field', async () => {
    // Owner attributed by artist name; her playlist carries the title and tag bait.
    const mira = await seedSharedPlaylist({
      name: 'Rainy Balcony Tapes',
      sharedAt: NOW,
      trackTitle: 'Glass Elevator',
      genreTags: ['vaporwave', 'chillhop'],
    });
    await testDb.pool.query(
      'insert into listener_profiles (owner_user_id, artist_name) values ($1, $2)',
      [mira.ownerUserId, 'Nightowl'],
    );
    // Second owner matched by his User name.
    const jonas = await seedSharedPlaylist({ name: 'Kitchen Discotheque', sharedAt: at(1) });
    await testDb.pool.query('update "user" set name = $1 where id = $2', [
      'Jonas Brandt',
      jonas.ownerUserId,
    ]);
    // A non-empty PRIVATE playlist whose name matches must never surface.
    const { ownerUserId: hermit, trackId } = await seedReadyTrack(testDb.db);
    const stash = await createPlaylist(testDb.db, { ownerUserId: hermit, name: 'Balcony Stash' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: hermit,
      playlistId: stash.id,
      trackIds: [trackId],
    });

    const byName = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'balcony',
    });
    expect(byName.items.map((item) => item.id)).toEqual([mira.playlistId]);
    expect(byName.items[0]?.match?.field).toBe('name');
    expect(byName.items[0]?.match?.snippet).toContain('Balcony');

    const byArtist = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'nightowl',
    });
    expect(byArtist.items.map((item) => item.id)).toEqual([mira.playlistId]);
    expect(byArtist.items[0]?.match?.field).toBe('owner');
    expect(byArtist.items[0]?.match?.snippet).toBe('Nightowl');

    const byFirstName = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'jonas',
    });
    expect(byFirstName.items.map((item) => item.id)).toEqual([jonas.playlistId]);
    expect(byFirstName.items[0]?.match?.field).toBe('owner');
    expect(byFirstName.items[0]?.match?.snippet).toBe('Jonas Brandt');

    const byTrackTitle = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'elevator',
    });
    expect(byTrackTitle.items.map((item) => item.id)).toEqual([mira.playlistId]);
    expect(byTrackTitle.items[0]?.match?.field).toBe('tracks');
    expect(byTrackTitle.items[0]?.match?.snippet).toBe('Glass Elevator');

    const byTag = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'chillhop',
    });
    expect(byTag.items.map((item) => item.id)).toEqual([mira.playlistId]);
    expect(byTag.items[0]?.match?.field).toBe('tags');
    expect(byTag.items[0]?.match?.snippet).toBe('chillhop');

    const byTidiedTag = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'chill hop',
    });
    expect(byTidiedTag.items.map((item) => item.id)).toEqual([mira.playlistId]);
    expect(byTidiedTag.items[0]?.match).toEqual({ field: 'tags', snippet: 'chillhop' });

    // Only genre tags ignore punctuation: an owner name matches as stored.
    const byOwnerPunctuated = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'night owl',
    });
    expect(byOwnerPunctuated.items).toEqual([]);
  });

  it('a track hit surfaces every containing shared playlist, each exactly once', async () => {
    // One track filed in two of its owner's In-Lounge playlists: both must
    // surface, and neither row may be duplicated by the membership probe.
    const first = await seedSharedPlaylist({
      name: 'Morning Side',
      sharedAt: NOW,
      trackTitle: 'Copper Kettle',
    });
    const second = await createPlaylist(testDb.db, {
      ownerUserId: first.ownerUserId,
      name: 'Evening Side',
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: first.ownerUserId,
      playlistId: second.id,
      trackIds: [first.trackId],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: first.ownerUserId,
      playlistId: second.id,
      audience: { kind: 'everyone' },
      now: at(1),
    });

    const page = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'kettle',
    });
    expect(page.items.map((item) => item.id)).toEqual([second.id, first.playlistId]);
    expect(page.items.map((item) => item.match?.field)).toEqual(['tracks', 'tracks']);
  });

  it('keeps the newest-shared-first order under a query — filter semantics, never a re-rank', async () => {
    // The older entry matches better (whole-name equality) than the newer one
    // (an anywhere tag hit); a relevance sort would flip them.
    const exact = await seedSharedPlaylist({ name: 'Vaporwave', sharedAt: NOW });
    const loose = await seedSharedPlaylist({
      name: 'Late Shift',
      sharedAt: at(1),
      genreTags: ['dark vaporwave revival'],
    });

    const page = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'vaporwave',
    });
    expect(page.items.map((item) => item.id)).toEqual([loose.playlistId, exact.playlistId]);
  });

  it('never matches sung lyrics', async () => {
    await seedSharedPlaylist({
      name: 'Quiet Hours',
      sharedAt: NOW,
      trackTitle: 'Untitled',
      lyrics: 'meet me under the xylophone moon',
    });

    const page = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'xylophone',
    });
    expect(page.items).toEqual([]);
  });

  it('composes the member filter with the query — both narrow, neither wins alone', async () => {
    const anna = await seedSharedPlaylist({
      name: 'Night Shift Radio',
      sharedAt: NOW,
      genreTags: ['ambient'],
    });
    await seedSharedPlaylist({
      name: 'Second Wind',
      sharedAt: at(1),
      ownerUserId: anna.ownerUserId,
      sessionId: anna.sessionId,
    });
    const jonas = await seedSharedPlaylist({
      name: 'Marathon Build-Up',
      sharedAt: at(2),
      genreTags: ['ambient'],
    });

    // Member filter alone: only that member's shares.
    const chipOnly = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      ownerUserId: anna.ownerUserId,
    });
    expect(chipOnly.items.map((item) => item.name)).toEqual(['Second Wind', 'Night Shift Radio']);

    // Member filter + query: the other member's matching share must stay out.
    const composed = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      ownerUserId: anna.ownerUserId,
      query: 'ambient',
    });
    expect(composed.items.map((item) => item.id)).toEqual([anna.playlistId]);
    expect(composed.items[0]?.match?.field).toBe('tags');

    // Query alone still spans owners.
    const queryOnly = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 10,
      query: 'ambient',
    });
    expect(queryOnly.items.map((item) => item.id)).toEqual([jonas.playlistId, anna.playlistId]);
  });

  it('pages newest-shared-first through a sharedAt tie without skipping or repeating entries', async () => {
    // Two entries share one instant: a keyset without the id tie-break arm
    // would drop or repeat one of them across the page boundary.
    const oldest = await seedSharedPlaylist({ name: 'Oldest', sharedAt: NOW });
    const tiedA = await seedSharedPlaylist({ name: 'Tied A', sharedAt: at(5) });
    const tiedB = await seedSharedPlaylist({ name: 'Tied B', sharedAt: at(5) });
    const newest = await seedSharedPlaylist({ name: 'Newest', sharedAt: at(9) });

    const first = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.id).toBe(newest.playlistId);
    expect(first.nextCursor).not.toBeNull();

    const second = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.items[1]?.id).toBe(oldest.playlistId);
    expect(second.nextCursor).toBeNull();

    const walked = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(walked).size).toBe(4);
    expect(walked.slice(1, 3).sort()).toEqual([tiedA.playlistId, tiedB.playlistId].sort());
  });
});

describe.skipIf(skip)('Pins in the Lounge order', () => {
  function pin(playlistId: string, viewerUserId = bystander) {
    return setPlaylistLoungePinned(testDb.db, { viewerUserId, playlistId, pinned: true });
  }

  it('lists the last pinned first, then the rest newest-shared first', async () => {
    const a = await seedSharedPlaylist({ name: 'A', sharedAt: at(1) });
    await seedSharedPlaylist({ name: 'B', sharedAt: at(2) });
    const c = await seedSharedPlaylist({ name: 'C', sharedAt: at(3) });
    await seedSharedPlaylist({ name: 'D', sharedAt: at(4) });

    await pin(a.playlistId);
    await pin(c.playlistId);

    const page = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 10 });
    expect(page.items.map((item) => item.name)).toEqual(['C', 'A', 'D', 'B']);
  });

  it('lists your own pinned share first too', async () => {
    const mine = await seedSharedPlaylist({ name: 'Mine', sharedAt: at(1) });
    await seedSharedPlaylist({ name: 'Newer', sharedAt: at(2) });

    await pin(mine.playlistId, mine.ownerUserId);

    const page = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: mine.ownerUserId,
      limit: 10,
    });
    expect(page.items.map((item) => item.name)).toEqual(['Mine', 'Newer']);
  });

  it('is per viewer: somebody else’s Pin moves nothing in your Lounge', async () => {
    const older = await seedSharedPlaylist({ name: 'Older', sharedAt: at(1) });
    await seedSharedPlaylist({ name: 'Newer', sharedAt: at(2) });
    await pin(older.playlistId, await createUser(testDb.db));

    const page = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 10 });
    expect(page.items.map((item) => item.name)).toEqual(['Newer', 'Older']);
  });

  it('rides Pins on the first page outside the limit, with no duplicate or missing row', async () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const ids = new Map<string, string>();
    for (const [index, name] of names.entries()) {
      const { playlistId } = await seedSharedPlaylist({ name, sharedAt: at(index) });
      ids.set(name, playlistId);
    }
    await pin(ids.get('B')!);
    await pin(ids.get('E')!);

    const first = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(['E', 'B', 'F', 'D']);
    const second = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.name)).toEqual(['C', 'A']);
    expect(second.nextCursor).toBeNull();
  });

  it('holds under a query and the member filter: matching Pins first, the others filtered out', async () => {
    const pinnedMatch = await seedSharedPlaylist({ name: 'Rain A', sharedAt: at(1) });
    const owner = pinnedMatch.ownerUserId;
    const sibling = { ownerUserId: owner, sessionId: pinnedMatch.sessionId };
    const pinnedMiss = await seedSharedPlaylist({ name: 'Sun', sharedAt: at(2), ...sibling });
    await seedSharedPlaylist({ name: 'Rain B', sharedAt: at(3), ...sibling });
    const otherOwnersPin = await seedSharedPlaylist({ name: 'Rain C', sharedAt: at(4) });
    await pin(pinnedMatch.playlistId);
    await pin(pinnedMiss.playlistId);
    await pin(otherOwnersPin.playlistId);

    const queried = await listLoungePlaylistsPage(testDb.db, {
      viewerUserId: bystander,
      limit: 1,
      query: 'rain',
      ownerUserId: owner,
    });
    expect(queried.items.map((item) => item.name)).toEqual(['Rain A', 'Rain B']);
    expect(queried.items.map((item) => item.match?.field)).toEqual(['name', 'name']);
    expect(queried.nextCursor).toBeNull();
  });

  it('keeps a pinned playlist out of the Lounge once it empties', async () => {
    const { ownerUserId, playlistId, trackId } = await seedSharedPlaylist({
      name: 'Soon empty',
      sharedAt: at(1),
    });
    await pin(playlistId);

    await removePlaylistTrack(testDb.db, { ownerUserId, playlistId, trackId });

    const page = await listLoungePlaylistsPage(testDb.db, { viewerUserId: bystander, limit: 10 });
    expect(page.items).toEqual([]);
  });
});

describe.skipIf(skip)('listLoungeSharers', () => {
  it('lists only owners with a listable share — empty shares and private stashes mint no card', async () => {
    const sharer = await seedSharedPlaylist({ name: 'Rainy Balcony Tapes', sharedAt: NOW });
    await testDb.pool.query(
      'insert into listener_profiles (owner_user_id, artist_name) values ($1, $2)',
      [sharer.ownerUserId, 'Nightowl'],
    );
    // Sharing twice must not mint two cards.
    await seedSharedPlaylist({
      name: 'Sunday Slow Cooking',
      sharedAt: at(1),
      ownerUserId: sharer.ownerUserId,
      sessionId: sharer.sessionId,
    });
    // An owner whose only In-Lounge playlist is EMPTY would be a dead card.
    const emptySharer = await createUser(testDb.db);
    const empty = await createPlaylist(testDb.db, {
      ownerUserId: emptySharer,
      name: 'Dead Entry',
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: emptySharer,
      playlistId: empty.id,
      audience: { kind: 'everyone' },
      now: at(2),
    });
    // An owner with only PRIVATE playlists must never leak into the cards.
    const { ownerUserId: hermit, trackId } = await seedReadyTrack(testDb.db);
    const stash = await createPlaylist(testDb.db, { ownerUserId: hermit, name: 'Stash' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: hermit,
      playlistId: stash.id,
      trackIds: [trackId],
    });

    const sharers = await listLoungeSharers(testDb.db, { viewerUserId: bystander });
    expect(sharers.map((row) => row.userId)).toEqual([sharer.ownerUserId]);
    expect(sharers[0]?.artistName).toBe('Nightowl');
  });

  it('carries the profile description, null without one', async () => {
    const described = await seedSharedPlaylist({ name: 'Rainy Balcony Tapes', sharedAt: NOW });
    const undescribed = await seedSharedPlaylist({ name: 'Sunday Slow Cooking', sharedAt: at(1) });
    await testDb.pool.query(
      `insert into listener_profiles (owner_user_id, artist_name, description)
       values ($1, 'Anna', 'Late-night tapes and rainy windows'), ($2, 'Bert', null)`,
      [described.ownerUserId, undescribed.ownerUserId],
    );

    const sharers = await listLoungeSharers(testDb.db, { viewerUserId: bystander });
    expect(sharers.map((row) => [row.userId, row.description])).toEqual([
      [described.ownerUserId, 'Late-night tapes and rainy windows'],
      [undescribed.ownerUserId, null],
    ]);
  });

  it('counts each track the viewer can hear once, across only the playlists shared with them', async () => {
    const first = await seedSharedPlaylist({ name: 'Rainy Balcony Tapes', sharedAt: NOW });
    const second = await seedSharedPlaylist({
      name: 'Sunday Slow Cooking',
      sharedAt: at(1),
      ownerUserId: first.ownerUserId,
      sessionId: first.sessionId,
    });
    // The same track in two shared playlists is one track shared.
    await addPlaylistTracks(testDb.db, {
      ownerUserId: first.ownerUserId,
      playlistId: second.playlistId,
      trackIds: [first.trackId],
    });
    // A playlist shared with selected Users that exclude the viewer is not theirs to count.
    const someoneElse = await createUser(testDb.db);
    await seedSharedPlaylist({
      name: 'For Someone Else',
      sharedAt: at(2),
      ownerUserId: first.ownerUserId,
      sessionId: first.sessionId,
      audience: { kind: 'selected', userIds: [someoneElse] },
    });

    const sharers = await listLoungeSharers(testDb.db, { viewerUserId: bystander });
    expect(sharers.map((row) => [row.userId, row.sharedTrackCount])).toEqual([
      [first.ownerUserId, 2],
    ]);
    const forSomeoneElse = await listLoungeSharers(testDb.db, { viewerUserId: someoneElse });
    expect(forSomeoneElse[0]?.sharedTrackCount).toBe(3);
  });
});

// The visitor's read of one shared playlist: the same uniform-404
// semantics as every widened read — unknown, private, and revoked ids are all
// null — with owner attribution and members gated on the one audibility
// predicate.

describe.skipIf(skip)('getLoungePlaylistDetail', () => {
  it('serves a foreign In-Lounge playlist with attribution; private, unknown, and revoked ids all read null', async () => {
    const mira = await seedSharedPlaylist({
      name: 'Rainy Balcony Tapes',
      sharedAt: NOW,
      trackTitle: 'Balcony Rain',
    });
    await testDb.pool.query('update "user" set name = $1, image = $2 where id = $3', [
      'Mira Marlowe',
      '/api/avatar/00000000-0000-4000-8000-00000000aaaa',
      mira.ownerUserId,
    ]);
    await testDb.pool.query(
      'insert into listener_profiles (owner_user_id, artist_name) values ($1, $2)',
      [mira.ownerUserId, 'Nightowl'],
    );
    const visitor = await createUser(testDb.db);

    const detail = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: mira.playlistId,
      limit: 10,
    });
    expect(detail).not.toBeNull();
    expect(detail!.playlist.id).toBe(mira.playlistId);
    expect(detail!.playlist.name).toBe('Rainy Balcony Tapes');
    expect(detail!.playlist.trackCount).toBe(1);
    expect(detail!.playlist.sharedAt).toEqual(NOW);
    expect(detail!.owner.name).toBe('Mira Marlowe');
    expect(detail!.owner.artistName).toBe('Nightowl');
    expect(detail!.owner.imageUrl).toBe('/api/avatar/00000000-0000-4000-8000-00000000aaaa');
    expect(detail!.items.map((item) => item.id)).toEqual([mira.trackId]);
    expect(detail!.items[0]!.title).toBe('Balcony Rain');
    expect(detail!.nextCursor).toBeNull();

    // A non-empty PRIVATE playlist must read exactly like an unknown id.
    const { ownerUserId: hermit, trackId } = await seedReadyTrack(testDb.db);
    const stash = await createPlaylist(testDb.db, { ownerUserId: hermit, name: 'Stash' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: hermit,
      playlistId: stash.id,
      trackIds: [trackId],
    });
    expect(
      await getLoungePlaylistDetail(testDb.db, {
        viewerUserId: visitor,
        playlistId: stash.id,
        limit: 10,
      }),
    ).toBeNull();
    expect(
      await getLoungePlaylistDetail(testDb.db, {
        viewerUserId: visitor,
        playlistId: crypto.randomUUID(),
        limit: 10,
      }),
    ).toBeNull();

    // Revocation closes the read the moment the owner returns to Private.
    await setPlaylistShared(testDb.db, {
      ownerUserId: mira.ownerUserId,
      playlistId: mira.playlistId,
      audience: null,
    });
    expect(
      await getLoungePlaylistDetail(testDb.db, {
        viewerUserId: visitor,
        playlistId: mira.playlistId,
        limit: 10,
      }),
    ).toBeNull();
  });

  it('hides members whose own owner does not share them, and keeps the counts truthful', async () => {
    // Jonas shares a mixtape holding HIS track plus a reference to Mira's
    // PRIVATE track — the reference must appear only while Mira shares it
    // herself (the owner-anchored predicate; re-share semantics).
    const jonas = await seedSharedPlaylist({
      name: 'Mixtape',
      sharedAt: NOW,
      trackTitle: 'Jonas Cut',
    });
    const mira = await seedReadyTrack(testDb.db);
    await testDb.pool.query('update tracks set duration_seconds = 200 where id in ($1, $2)', [
      jonas.trackId,
      mira.trackId,
    ]);
    await testDb.pool.query(
      'insert into playlist_tracks (playlist_id, track_id, position) values ($1, $2, 1)',
      [jonas.playlistId, mira.trackId],
    );
    const visitor = await createUser(testDb.db);

    const hidden = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: jonas.playlistId,
      limit: 10,
    });
    expect(hidden!.items.map((item) => item.id)).toEqual([jonas.trackId]);
    // The summary counts what the visitor can actually reach — a phantom count
    // would leave the client's Load more spinning on pages that never come.
    expect(hidden!.playlist.trackCount).toBe(1);
    expect(hidden!.playlist.totalDurationSeconds).toBe(200);

    // Mira sharing the track herself (via her own In-Lounge playlist) makes
    // the reference audible here too.
    const miraList = await createPlaylist(testDb.db, {
      ownerUserId: mira.ownerUserId,
      name: 'Mira Shares',
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: mira.ownerUserId,
      playlistId: miraList.id,
      trackIds: [mira.trackId],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: mira.ownerUserId,
      playlistId: miraList.id,
      audience: { kind: 'everyone' },
      now: at(1),
    });
    const revealed = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: jonas.playlistId,
      limit: 10,
    });
    expect(revealed!.items.map((item) => item.id)).toEqual([jonas.trackId, mira.trackId]);
    expect(revealed!.playlist.trackCount).toBe(2);
    // The playlist's own owner is the header's attribution; the reference
    // carries its own owner's.
    await testDb.pool.query('update "user" set name = $1 where id = $2', [
      'Mira Marlowe',
      mira.ownerUserId,
    ]);
    const attributed = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: jonas.playlistId,
      limit: 10,
    });
    expect(attributed!.items.map((item) => item.owner?.name ?? null)).toEqual([
      null,
      'Mira Marlowe',
    ]);
  });

  it('never carries the owner’s retention shelves to a visitor — the flags read empty', async () => {
    // Membership implies Save owner-side, so the fixture's savedAt IS set;
    // serving it would leak the owner's Library facts into foreign UI state.
    const mira = await seedSharedPlaylist({ name: 'Kept', sharedAt: NOW });
    const raw = await testDb.pool.query('select saved_at from tracks where id = $1', [
      mira.trackId,
    ]);
    expect(raw.rows[0].saved_at).not.toBeNull();

    const visitor = await createUser(testDb.db);
    const detail = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: mira.playlistId,
      limit: 10,
    });
    expect(detail!.items[0]!.savedAt).toBeNull();
    expect(detail!.items[0]!.favoritedAt).toBeNull();
    expect(detail!.items[0]!.dislikedAt).toBeNull();
    expect(detail!.items[0]!.inCuratedPlaylist).toBe(false);
  });

  it('pages members on the position keyset without skipping or repeating a row', async () => {
    const first = await seedSharedPlaylist({ name: 'Long Tape', sharedAt: NOW });
    const second = await seedReadyTrack(testDb.db, {
      ownerUserId: first.ownerUserId,
      sessionId: first.sessionId,
    });
    const third = await seedReadyTrack(testDb.db, {
      ownerUserId: first.ownerUserId,
      sessionId: first.sessionId,
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: first.ownerUserId,
      playlistId: first.playlistId,
      trackIds: [second.trackId, third.trackId],
    });
    const visitor = await createUser(testDb.db);

    const pageOne = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: first.playlistId,
      limit: 2,
    });
    expect(pageOne!.items.map((item) => item.id)).toEqual([first.trackId, second.trackId]);
    expect(pageOne!.nextCursor).toBe('1');

    const pageTwo = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: visitor,
      playlistId: first.playlistId,
      cursor: pageOne!.nextCursor,
      limit: 2,
    });
    expect(pageTwo!.items.map((item) => item.id)).toEqual([third.trackId]);
    expect(pageTwo!.nextCursor).toBeNull();
  });
});

// A `selected` audience: exactly the picked Users — and the
// owner — see the playlist; to everyone else, the Admin included, it reads
// exactly like a Private one.
describe.skipIf(skip)('selected audience', () => {
  it('lists, attributes, and serves the playlist only to its owner and the picked Users', async () => {
    const picked = await createUser(testDb.db);
    const outsider = await createUser(testDb.db);
    const duo = await seedSharedPlaylist({
      name: 'For two',
      sharedAt: NOW,
      audience: { kind: 'selected', userIds: [picked] },
    });
    const open = await seedSharedPlaylist({ name: 'For all', sharedAt: at(1) });

    const listed = async (viewerUserId: string) =>
      (await listLoungePlaylistsPage(testDb.db, { viewerUserId, limit: 10 })).items.map(
        (item) => item.id,
      );
    expect(await listed(picked)).toEqual([open.playlistId, duo.playlistId]);
    expect(await listed(duo.ownerUserId)).toEqual([open.playlistId, duo.playlistId]);
    expect(await listed(outsider)).toEqual([open.playlistId]);

    const sharers = async (viewerUserId: string) =>
      (await listLoungeSharers(testDb.db, { viewerUserId })).map((row) => row.userId).sort();
    expect(await sharers(picked)).toEqual([duo.ownerUserId, open.ownerUserId].sort());
    expect(await sharers(outsider)).toEqual([open.ownerUserId]);

    const detail = (viewerUserId: string) =>
      getLoungePlaylistDetail(testDb.db, { viewerUserId, playlistId: duo.playlistId, limit: 10 });
    expect((await detail(picked))!.items.map((item) => item.id)).toEqual([duo.trackId]);
    expect(await detail(outsider)).toBeNull();
  });
});

// A re-share never carries a Shared reference past the audience its own owner
// chose: X shares T with V alone; V re-shares a playlist
// holding a reference to T with everyone. W, outside X's audience, sees V's
// playlist — but nothing of T through it: no count, no playtime, no mosaic
// tile, no search match, and no listing when T is all the playlist holds.
describe.skipIf(skip)('re-shared references under a selected audience', () => {
  /** T: X's track, cover and title set, shared with `v` alone. */
  async function seedNarrowTrack(v: string) {
    const x = await seedSharedPlaylist({
      name: 'For V',
      sharedAt: NOW,
      trackTitle: 'Secret Song',
      genreTags: ['hushcore'],
      audience: { kind: 'selected', userIds: [v] },
    });
    const cover = await createCoverImage(testDb.db);
    await testDb.pool.query(
      'update tracks set cover_image_id = $1, duration_seconds = 300 where id = $2',
      [cover, x.trackId],
    );
    return { ownerUserId: x.ownerUserId, trackId: x.trackId, cover };
  }

  /** V's own track plus the reference to T, shared with everyone. */
  async function seedReshare() {
    const v = await createUser(testDb.db);
    const w = await createUser(testDb.db);
    const t = await seedNarrowTrack(v);
    const mixtape = await seedSharedPlaylist({
      name: 'Mixtape',
      sharedAt: at(1),
      ownerUserId: v,
      trackTitle: 'Open Song',
    });
    const ownCover = await createCoverImage(testDb.db);
    await testDb.pool.query(
      'update tracks set cover_image_id = $1, duration_seconds = 200 where id = $2',
      [ownCover, mixtape.trackId],
    );
    expect(
      await applyTrackMemberships(testDb.db, {
        ownerUserId: v,
        trackId: t.trackId,
        playlistIds: [mixtape.playlistId],
      }),
    ).not.toBeNull();
    return { v, w, t, mixtape, ownCover };
  }

  it('counts, times, and tiles only the members the viewer can hear', async () => {
    const { v, w, t, mixtape, ownCover } = await seedReshare();

    const entry = async (viewerUserId: string) =>
      (await listLoungePlaylistsPage(testDb.db, { viewerUserId, limit: 10 })).items.find(
        (item) => item.id === mixtape.playlistId,
      )!;
    expect(await entry(w)).toMatchObject({
      trackCount: 1,
      totalDurationSeconds: 200,
      mosaicCoverImageIds: [ownCover],
    });
    expect(await entry(v)).toMatchObject({
      trackCount: 2,
      totalDurationSeconds: 500,
      mosaicCoverImageIds: [ownCover, t.cover],
    });

    const detail = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: w,
      playlistId: mixtape.playlistId,
      limit: 10,
    });
    expect(detail!.items.map((item) => item.id)).toEqual([mixtape.trackId]);
    expect(detail!.playlist).toMatchObject({
      trackCount: 1,
      totalDurationSeconds: 200,
      mosaicCoverImageIds: [ownCover],
    });
  });

  it('never matches a Lounge search on a member hidden from the viewer', async () => {
    const { v, w, mixtape } = await seedReshare();

    const search = async (viewerUserId: string, query: string) =>
      (await listLoungePlaylistsPage(testDb.db, { viewerUserId, query, limit: 10 })).items;
    expect(await search(w, 'secret')).toEqual([]);
    expect(await search(w, 'hushcore')).toEqual([]);
    // The shared title still matches — on V's own member, never on T.
    const [hit] = await search(w, 'song');
    expect(hit).toMatchObject({
      id: mixtape.playlistId,
      match: { field: 'tracks', snippet: 'Open Song' },
    });

    // Inside X's audience, the reference matches like any member.
    const insider = await search(v, 'secret');
    expect(insider.map((item) => item.id)).toContain(mixtape.playlistId);
  });

  it('does not list a playlist, or its owner as a sharer, when every member is hidden', async () => {
    const v = await createUser(testDb.db);
    const w = await createUser(testDb.db);
    const t = await seedNarrowTrack(v);
    const onlyTheirs = await createPlaylist(testDb.db, { ownerUserId: v, name: 'Only Theirs' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: v,
      trackId: t.trackId,
      playlistIds: [onlyTheirs.id],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: v,
      playlistId: onlyTheirs.id,
      audience: { kind: 'everyone' },
      now: at(1),
    });

    const listed = async (viewerUserId: string) =>
      (await listLoungePlaylistsPage(testDb.db, { viewerUserId, limit: 10 })).items.map(
        (item) => item.id,
      );
    expect(await listed(w)).toEqual([]);
    expect(await listed(v)).toContain(onlyTheirs.id);
    expect(await listLoungeSharers(testDb.db, { viewerUserId: w })).toEqual([]);
  });
});
