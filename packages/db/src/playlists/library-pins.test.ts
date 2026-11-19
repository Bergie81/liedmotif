import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { addPlaylistTracks, createPlaylist, ensureFavoritesPlaylist } from './playlists-repo';
import { listPlaylists, listPlaylistsPage } from './playlist-reads';
import { getLoungePlaylistDetail, listLoungePlaylistsPage } from './lounge-repo';
import { setPlaylistShared } from './playlist-share-repo';
import { setPlaylistLibraryPinned, setPlaylistLoungePinned } from './pins-repo';

// A Library pin: the owner's own playlist comes first in
// their Playlists tab, newest pin first — no section of its own, and nothing to
// do with the Lounge.

const skip = !TEST_DATABASE_URL;

const TABLES = [
  'playlist_pins',
  'playlist_tracks',
  'playlists',
  ...GENERATION_FIXTURE_TABLES,
] as const;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('library-pins-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

/** An owner whose playlists' activity order is the given names, oldest first. */
async function seedOwner(names: string[]): Promise<{
  ownerUserId: string;
  idOf: (name: string) => string;
}> {
  const ownerUserId = await createUser(testDb.db);
  await ensureFavoritesPlaylist(testDb.db, { ownerUserId });
  const ids = new Map<string, string>();
  for (const [index, name] of names.entries()) {
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
    await testDb.pool.query('update playlists set updated_at = $1 where id = $2', [
      new Date(Date.UTC(2026, 0, 1, 0, index)),
      playlist.id,
    ]);
    ids.set(name, playlist.id);
  }
  return { ownerUserId, idOf: (name) => ids.get(name)! };
}

function pin(ownerUserId: string, playlistId: string, pinned = true) {
  return setPlaylistLibraryPinned(testDb.db, { ownerUserId, playlistId, pinned });
}

describe.skipIf(skip)('Library pin order', () => {
  it('lists the last pinned first, then the rest by activity, Favorites keeping its slot', async () => {
    const { ownerUserId, idOf } = await seedOwner(['A', 'B', 'C', 'D']);

    await pin(ownerUserId, idOf('A'));
    await pin(ownerUserId, idOf('C'));

    const expected = ['Favorites', 'C', 'A', 'D', 'B'];
    const listed = await listPlaylists(testDb.db, { ownerUserId });
    expect(listed.map((p) => p.name)).toEqual(expected);
    const page = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 10 });
    expect(page.items.map((p) => p.name)).toEqual(expected);
    expect(page.items.map((p) => p.pinnedAt !== null)).toEqual([false, true, true, false, false]);
  });

  it('re-pinning keeps the original place in the order', async () => {
    const { ownerUserId, idOf } = await seedOwner(['A', 'B']);
    await pin(ownerUserId, idOf('A'));
    await pin(ownerUserId, idOf('B'));

    await pin(ownerUserId, idOf('A'));

    const page = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 10 });
    expect(page.items.map((p) => p.name)).toEqual(['Favorites', 'B', 'A']);
  });

  it('pinning and unpinning leave the activity order alone', async () => {
    const { ownerUserId, idOf } = await seedOwner(['A', 'B', 'C']);
    const before = await listPlaylists(testDb.db, { ownerUserId, playlistId: idOf('A') });

    await pin(ownerUserId, idOf('A'));
    await pin(ownerUserId, idOf('A'), false);

    const after = await listPlaylists(testDb.db, { ownerUserId, playlistId: idOf('A') });
    expect(after[0]!.updatedAt).toEqual(before[0]!.updatedAt);
    expect(after[0]!.pinnedAt).toBeNull();
    const page = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 10 });
    expect(page.items.map((p) => p.name)).toEqual(['Favorites', 'C', 'B', 'A']);
  });

  it('rides pinned rows on the first page outside the limit, with no duplicate or missing row', async () => {
    const { ownerUserId, idOf } = await seedOwner(['A', 'B', 'C', 'D', 'E', 'F']);
    await pin(ownerUserId, idOf('B'));
    await pin(ownerUserId, idOf('E'));

    const first = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 2 });
    expect(first.items.map((p) => p.name)).toEqual(['Favorites', 'E', 'B', 'F', 'D']);
    const second = await listPlaylistsPage(testDb.db, {
      ownerUserId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((p) => p.name)).toEqual(['C', 'A']);
    expect(second.nextCursor).toBeNull();
  });

  it('holds while searching: matching pinned rows first, the others filtered out', async () => {
    const { ownerUserId, idOf } = await seedOwner(['Chill A', 'Workout', 'Chill B', 'Chill C']);
    await pin(ownerUserId, idOf('Chill A'));
    await pin(ownerUserId, idOf('Workout'));

    const first = await listPlaylistsPage(testDb.db, { ownerUserId, search: 'chill', limit: 1 });
    expect(first.items.map((p) => p.name)).toEqual(['Chill A', 'Chill C']);
    const second = await listPlaylistsPage(testDb.db, {
      ownerUserId,
      search: 'chill',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((p) => p.name)).toEqual(['Chill B']);
    expect(second.nextCursor).toBeNull();
    const listed = await listPlaylists(testDb.db, { ownerUserId, search: 'chill' });
    expect(listed.map((p) => p.name)).toEqual(['Chill A', 'Chill C', 'Chill B']);
  });

  it('has no cap', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `P${index}`);
    const { ownerUserId, idOf } = await seedOwner(names);

    for (const name of names) expect(await pin(ownerUserId, idOf(name))).toBe('ok');

    const page = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 2 });
    expect(page.items.filter((p) => p.pinnedAt !== null)).toHaveLength(12);
    expect(page.nextCursor).toBeNull();
  });
});

describe.skipIf(skip)('setPlaylistLibraryPinned refusals', () => {
  it('reaches only the owner’s own curated playlists', async () => {
    const { ownerUserId, idOf } = await seedOwner(['Mine']);
    const stranger = await createUser(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId });

    expect(await pin(stranger, idOf('Mine'))).toBe('not_found');
    expect(await pin(ownerUserId, randomUUID())).toBe('not_found');
    expect(await pin(ownerUserId, favorites.id)).toBe('not_found');

    const page = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 10 });
    expect(page.items.every((p) => p.pinnedAt === null)).toBe(true);
  });

  it('unpinning a playlist that is not pinned is a no-op', async () => {
    const { ownerUserId, idOf } = await seedOwner(['Mine']);

    expect(await pin(ownerUserId, idOf('Mine'), false)).toBe('ok');
  });
});

describe.skipIf(skip)('the two pin orders are independent', () => {
  /** A non-empty shared playlist of `ownerUserId`. */
  async function seedShared(name: string) {
    const { ownerUserId, trackId } = await seedReadyTrack(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
    await addPlaylistTracks(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      trackIds: [trackId],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });
    return { ownerUserId, playlistId: playlist.id };
  }

  it('a Lounge pin of a foreign playlist never lists it in the Library', async () => {
    const { playlistId } = await seedShared('Foreign');
    const viewer = await createUser(testDb.db);

    await setPlaylistLoungePinned(testDb.db, { viewerUserId: viewer, playlistId, pinned: true });

    const library = await listPlaylistsPage(testDb.db, { ownerUserId: viewer, limit: 10 });
    expect(library.items).toEqual([]);
  });

  it('a Lounge pin of your own playlist does not pin it in your Library, nor the other way round', async () => {
    const { ownerUserId, playlistId } = await seedShared('Mine');
    const moreRecent = await createPlaylist(testDb.db, { ownerUserId, name: 'More recent' });
    await testDb.pool.query('update playlists set updated_at = $1 where id = $2', [
      new Date(Date.UTC(2030, 0, 1)),
      moreRecent.id,
    ]);
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId,
      pinned: true,
    });

    const library = await listPlaylistsPage(testDb.db, { ownerUserId, limit: 10 });
    expect(library.items.map((p) => [p.name, p.pinnedAt])).toEqual([
      ['More recent', null],
      ['Mine', null],
    ]);

    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: ownerUserId,
      playlistId,
      pinned: false,
    });
    await pin(ownerUserId, playlistId);
    const pinnedRows = await testDb.pool.query('select count(*)::int as n from playlist_pins');
    expect(pinnedRows.rows[0].n).toBe(0);
  });

  it('a Library pin survives unsharing and re-sharing', async () => {
    const { ownerUserId, playlistId } = await seedShared('Mine');
    await pin(ownerUserId, playlistId);

    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: null });
    await setPlaylistShared(testDb.db, { ownerUserId, playlistId, audience: { kind: 'everyone' } });

    const [row] = await listPlaylists(testDb.db, { ownerUserId, playlistId });
    expect(row!.pinnedAt).not.toBeNull();
  });

  it('an owner’s Library pin moves nothing in anybody’s Lounge and stays hidden from them', async () => {
    const { ownerUserId, playlistId } = await seedShared('Mine');
    const otherShare = await seedShared('Other');
    const viewer = await createUser(testDb.db);
    await pin(ownerUserId, playlistId);

    await testDb.pool.query('update playlists set shared_at = $1 where id = $2', [
      new Date(Date.UTC(2026, 0, 1)),
      playlistId,
    ]);
    const lounge = await listLoungePlaylistsPage(testDb.db, { viewerUserId: viewer, limit: 10 });
    expect(lounge.items.map((item) => item.id)).toEqual([otherShare.playlistId, playlistId]);
    const detail = await getLoungePlaylistDetail(testDb.db, {
      viewerUserId: viewer,
      playlistId,
      limit: 10,
    });
    expect(detail!.playlist.pinnedAt).toBeNull();
  });
});
