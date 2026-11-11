// What the Assistant does in the asking user's Library when its model calls an
// action tool, and what the reply stream then says was done. The route, the
// tools and the app's own Library functions run against a real database; a
// scripted model stands in for the text LLM.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPlaylistTracks,
  createPlaylist,
  ensureFavoritesPlaylist,
  getActiveSession,
  getPlaylistDetail,
  getSessionById,
  listPlaylists,
  setPlaylistLibraryPinned,
  setTrackFavorited,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import type { AssistantPlayerState, AssistantReceipt } from '@liedmotif/shared';
import { askWithToolCalls, type ToolCallsTurn } from '../helpers/assistant-tool-turn';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  llm: null as unknown,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? { session: { id: 'live' }, user: { id: holder.sessionUserId } }
          : null,
    },
  }),
}));
vi.mock('@/lib/providers', () => ({
  getLlmProvider: async () => holder.llm,
  getTypicalTracksPerMusicRequest: () => 2,
}));

const { POST } = await import('@/app/api/assistant/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/**
 * A Member named `name` under an id of their own. The route's burst limit
 * counts per user id for as long as the process lives, so no two tests share one.
 */
let members = 0;
async function createMember(name: string): Promise<string> {
  members += 1;
  const id = `${name}-${members}`;
  await testDb.db.insert(user).values({ id, name, email: `${id}@example.test` });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'member' });
  return id;
}

/** One Track per title in a stopped Session of `ownerUserId`. */
async function seedTracks(ownerUserId: string, ...titles: string[]): Promise<string[]> {
  const sessionId = await createSession(testDb.db, { ownerUserId, status: 'stopped' });
  const trackIds: string[] = [];
  for (const title of titles) {
    trackIds.push(await seedSessionTrack(testDb.db, ownerUserId, sessionId, { title }));
  }
  return trackIds;
}

/** `userId` sends one message; the model calls every one of `calls` at once. */
function act(
  userId: string,
  calls: { name: string; input: unknown }[],
  options: { player?: AssistantPlayerState; answer?: string[] } = {},
): Promise<ToolCallsTurn> {
  holder.sessionUserId = userId;
  return askWithToolCalls(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    calls,
    options,
  );
}

/** The receipts a reply stream carried, in order. */
const receipts = ({ events }: ToolCallsTurn): AssistantReceipt[] =>
  events.flatMap((event) =>
    event.type === 'action' && event.action.status === 'done' ? [event.action.receipt] : [],
  );

/** The titles in `userId`'s Favorites, in order. */
async function favoritesOf(userId: string): Promise<(string | null)[]> {
  const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId: userId });
  return membersOf(userId, favorites.id);
}

/** The titles in one of `userId`'s Playlists, in order. */
async function membersOf(userId: string, playlistId: string): Promise<(string | null)[]> {
  const detail = await getPlaylistDetail(testDb.db, {
    ownerUserId: userId,
    playlistId,
    limit: 100,
  });
  return detail!.items.map((item) => item.title);
}

/** The names of `userId`'s own Playlists, Favorites aside, in the Library's order. */
async function playlistNamesOf(userId: string): Promise<string[]> {
  const all = await listPlaylists(testDb.db, { ownerUserId: userId });
  return all.filter((playlist) => playlist.kind === 'user').map((playlist) => playlist.name);
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-acts-in-library-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, [
    'playlist_pins',
    'playlist_tracks',
    'playlists',
    ...GENERATION_FIXTURE_TABLES,
    'user_settings',
    'app_settings',
  ]);
  holder.sessionUserId = null;
});

describe.skipIf(skip)('the Assistant asked to favorite a Track', () => {
  it('adds it to the asker’s Favorites and sends a receipt naming the Track and where it is', async () => {
    const asker = await createMember('member');
    const [trackId] = await seedTracks(asker, 'Night Drive');

    const turn = await act(asker, [{ name: 'favoriteTrack', input: { trackId } }]);

    expect(await favoritesOf(asker)).toEqual(['Night Drive']);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId: asker });
    expect(receipts(turn)).toEqual([
      {
        action: 'favoriteTrack',
        track: { id: trackId, name: 'Night Drive' },
        playlist: { id: favorites.id, name: 'Favorites' },
      },
    ]);
    expect(turn.results[0]).toMatch(
      /^Done: added the Track "Night Drive" \(id .+\) to Favorites\.$/,
    );
    expect(turn.events.at(-1)).toEqual({ type: 'done' });
  });

  it('takes "this" from what the player has on the deck when the model names no Track', async () => {
    const asker = await createMember('member');
    const sessionId = await createSession(testDb.db, { ownerUserId: asker });
    const trackId = await seedSessionTrack(testDb.db, asker, sessionId, { title: 'On The Deck' });

    const turn = await act(asker, [{ name: 'favoriteTrack', input: {} }], {
      player: { source: { kind: 'session', id: sessionId }, trackId, playing: true },
    });

    expect(await favoritesOf(asker)).toEqual(['On The Deck']);
    expect(receipts(turn)).toMatchObject([{ track: { id: trackId, name: 'On The Deck' } }]);
  });

  it('says so, and does nothing, when no Track is named and nothing is playing', async () => {
    const asker = await createMember('member');
    await seedTracks(asker, 'Night Drive');

    const turn = await act(asker, [{ name: 'favoriteTrack', input: {} }]);

    expect(turn.results[0]).toMatch(/no track is playing/i);
    expect(receipts(turn)).toEqual([]);
    expect(await favoritesOf(asker)).toEqual([]);
  });

  it('refuses another user’s Track like one that does not exist, and sends no receipt', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');
    const [theirs] = await seedTracks(other, 'Private Take');

    const turn = await act(asker, [
      { name: 'favoriteTrack', input: { trackId: theirs } },
      { name: 'favoriteTrack', input: { trackId: '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22' } },
      { name: 'favoriteTrack', input: { trackId: 'not-an-id' } },
    ]);

    expect(new Set(turn.results)).toEqual(new Set(['No Track with that id. Nothing was changed.']));
    expect(receipts(turn)).toEqual([]);
    expect(await favoritesOf(asker)).toEqual([]);
    expect(await favoritesOf(other)).toEqual([]);
  });

  it('refuses a Track that was removed, and sends no receipt', async () => {
    const asker = await createMember('member');
    const sessionId = await createSession(testDb.db, { ownerUserId: asker, status: 'stopped' });
    const removed = await seedSessionTrack(testDb.db, asker, sessionId, {
      title: 'Gone',
      status: 'rejected',
    });

    const turn = await act(asker, [{ name: 'favoriteTrack', input: { trackId: removed } }]);

    expect(turn.results[0]).toMatch(/was removed.*nothing was changed/i);
    expect(receipts(turn)).toEqual([]);
    expect(await favoritesOf(asker)).toEqual([]);
  });
});

describe.skipIf(skip)('the Assistant asked to add Tracks to a Playlist', () => {
  it('appends them in the order given and sends one receipt naming the Playlist and the Tracks', async () => {
    const asker = await createMember('member');
    const [first, second, third] = await seedTracks(asker, 'Warm Up', 'Tempo', 'Cool Down');
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Running' });

    const turn = await act(asker, [
      {
        name: 'addToPlaylist',
        input: { playlistId: playlist.id, trackIds: [third, first, second] },
      },
    ]);

    expect(await membersOf(asker, playlist.id)).toEqual(['Cool Down', 'Warm Up', 'Tempo']);
    expect(receipts(turn)).toEqual([
      {
        action: 'addToPlaylist',
        playlist: { id: playlist.id, name: 'Running' },
        retention: 'curated',
        tracks: [
          { id: third, name: 'Cool Down' },
          { id: first, name: 'Warm Up' },
          { id: second, name: 'Tempo' },
        ],
      },
    ]);
    expect(turn.results[0]).toMatch(/^Done: added 3 Tracks to the Playlist "Running" \(id .+\)\.$/);
  });

  it('adds the Track on the deck when the model names none', async () => {
    const asker = await createMember('member');
    const sessionId = await createSession(testDb.db, { ownerUserId: asker });
    const trackId = await seedSessionTrack(testDb.db, asker, sessionId, { title: 'On The Deck' });
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Running' });

    const turn = await act(asker, [{ name: 'addToPlaylist', input: { playlistId: playlist.id } }], {
      player: { source: { kind: 'session', id: sessionId }, trackId, playing: false },
    });

    expect(await membersOf(asker, playlist.id)).toEqual(['On The Deck']);
    expect(receipts(turn)).toMatchObject([{ tracks: [{ id: trackId, name: 'On The Deck' }] }]);
  });

  it('adds what it can and tells the model what was already there and what it could not add', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');
    const [mine, already] = await seedTracks(asker, 'Mine', 'Already There');
    const [theirs] = await seedTracks(other, 'Private Take');
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Running' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: asker,
      playlistId: playlist.id,
      trackIds: [already!],
    });

    const turn = await act(asker, [
      {
        name: 'addToPlaylist',
        input: { playlistId: playlist.id, trackIds: [mine, already, theirs, 'not-an-id'] },
      },
    ]);

    expect(await membersOf(asker, playlist.id)).toEqual(['Already There', 'Mine']);
    expect(receipts(turn)).toMatchObject([{ tracks: [{ id: mine, name: 'Mine' }] }]);
    expect(turn.results[0]).toMatch(
      /^Done: added the Track "Mine" \(id .+\) to the Playlist "Running" \(id .+\)\. /,
    );
    expect(turn.results[0]).toMatch(/1 was already in it/);
    expect(turn.results[0]).toMatch(/2 could not be added/);
  });

  it('sends no receipt when nothing was added', async () => {
    const asker = await createMember('member');
    const [already] = await seedTracks(asker, 'Already There');
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Running' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: asker,
      playlistId: playlist.id,
      trackIds: [already!],
    });

    const turn = await act(asker, [
      { name: 'addToPlaylist', input: { playlistId: playlist.id, trackIds: [already] } },
    ]);

    expect(turn.results[0]).toMatch(/already in.*nothing was changed/i);
    expect(receipts(turn)).toEqual([]);
  });

  it('refuses another user’s Playlist like one that does not exist', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');
    const [mine] = await seedTracks(asker, 'Mine');
    const theirs = await createPlaylist(testDb.db, { ownerUserId: other, name: 'Theirs' });

    const turn = await act(asker, [
      { name: 'addToPlaylist', input: { playlistId: theirs.id, trackIds: [mine] } },
      { name: 'addToPlaylist', input: { playlistId: 'not-an-id', trackIds: [mine] } },
    ]);

    expect(new Set(turn.results)).toEqual(
      new Set(['No Playlist of this user with that id. Nothing was changed.']),
    );
    expect(receipts(turn)).toEqual([]);
    expect(await membersOf(other, theirs.id)).toEqual([]);
  });

  it('takes at most 20 Tracks: one more is an error, and nothing is added', async () => {
    const asker = await createMember('member');
    const titles = Array.from({ length: 21 }, (_, index) => `Take ${index + 1}`);
    const trackIds = await seedTracks(asker, ...titles);
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Everything' });

    const over = await act(asker, [
      { name: 'addToPlaylist', input: { playlistId: playlist.id, trackIds } },
    ]);

    expect(over.results[0]).toMatch(/at most 20 tracks.*nothing was changed/i);
    expect(receipts(over)).toEqual([]);
    expect(await membersOf(asker, playlist.id)).toEqual([]);

    const within = await act(asker, [
      {
        name: 'addToPlaylist',
        input: { playlistId: playlist.id, trackIds: trackIds.slice(0, 20) },
      },
    ]);

    expect(receipts(within)[0]).toMatchObject({ action: 'addToPlaylist' });
    expect(await membersOf(asker, playlist.id)).toEqual(titles.slice(0, 20));
  });
});

describe.skipIf(skip)('the Assistant asked to create, rename or pin a Playlist', () => {
  it('creates an empty Playlist of the asker’s under the name given', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');

    const turn = await act(asker, [{ name: 'createPlaylist', input: { name: '  Sunday  ' } }]);

    expect(await playlistNamesOf(asker)).toEqual(['Sunday']);
    expect(await playlistNamesOf(other)).toEqual([]);
    const [created] = await listPlaylists(testDb.db, { ownerUserId: asker });
    expect(receipts(turn)).toEqual([
      { action: 'createPlaylist', playlist: { id: created!.id, name: 'Sunday' } },
    ]);
    expect(turn.results[0]).toBe(`Done: created the Playlist "Sunday" (id ${created!.id}).`);
  });

  it('refuses a name the app would not take, and creates nothing', async () => {
    const asker = await createMember('member');

    const turn = await act(asker, [
      { name: 'createPlaylist', input: { name: '   ' } },
      { name: 'createPlaylist', input: { name: 'x'.repeat(61) } },
    ]);

    for (const result of turn.results) {
      expect(result).toMatch(/1 to 60 characters.*nothing was changed/i);
    }
    expect(receipts(turn)).toEqual([]);
    expect(await playlistNamesOf(asker)).toEqual([]);
  });

  it('renames the asker’s Playlist and says what it was called before', async () => {
    const asker = await createMember('member');
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Jogging' });

    const turn = await act(asker, [
      { name: 'renamePlaylist', input: { playlistId: playlist.id, name: 'Running' } },
    ]);

    expect(await playlistNamesOf(asker)).toEqual(['Running']);
    expect(receipts(turn)).toEqual([
      {
        action: 'renamePlaylist',
        playlist: { id: playlist.id, name: 'Running' },
        previousName: 'Jogging',
      },
    ]);
  });

  it('refuses to rename Favorites, another user’s Playlist and an id that names nothing', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId: asker });
    const theirs = await createPlaylist(testDb.db, { ownerUserId: other, name: 'Theirs' });

    const turn = await act(asker, [
      { name: 'renamePlaylist', input: { playlistId: favorites.id, name: 'Best Of' } },
      { name: 'renamePlaylist', input: { playlistId: theirs.id, name: 'Mine Now' } },
      { name: 'renamePlaylist', input: { playlistId: 'not-an-id', name: 'Anything' } },
    ]);

    expect(turn.results).toEqual([
      'Favorites cannot be renamed. Nothing was changed.',
      'No Playlist of this user with that id. Nothing was changed.',
      'No Playlist of this user with that id. Nothing was changed.',
    ]);
    expect(receipts(turn)).toEqual([]);
    expect((await ensureFavoritesPlaylist(testDb.db, { ownerUserId: asker })).name).toBe(
      favorites.name,
    );
    expect(await playlistNamesOf(other)).toEqual(['Theirs']);
  });

  it('pins the asker’s Playlist, which then lists first in their Library', async () => {
    const asker = await createMember('member');
    const pinned = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Older' });
    await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Newer' });

    const turn = await act(asker, [{ name: 'pinPlaylist', input: { playlistId: pinned.id } }]);

    expect(await playlistNamesOf(asker)).toEqual(['Older', 'Newer']);
    expect(receipts(turn)).toEqual([
      { action: 'pinPlaylist', playlist: { id: pinned.id, name: 'Older' } },
    ]);
  });

  it('refuses to pin Favorites and another user’s Playlist', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId: asker });
    const theirs = await createPlaylist(testDb.db, { ownerUserId: other, name: 'Theirs' });

    const turn = await act(asker, [
      { name: 'pinPlaylist', input: { playlistId: favorites.id } },
      { name: 'pinPlaylist', input: { playlistId: theirs.id } },
    ]);

    expect(turn.results).toEqual([
      'That Playlist cannot be pinned. Nothing was changed.',
      'No Playlist of this user with that id. Nothing was changed.',
    ]);
    expect(receipts(turn)).toEqual([]);
    const [theirsNow] = await listPlaylists(testDb.db, { ownerUserId: other });
    expect(theirsNow!.pinnedAt).toBeNull();
  });
});

describe.skipIf(skip)('the Assistant asked to switch New music off', () => {
  it('switches the asker’s active Session to Repeat and sends a receipt naming it', async () => {
    const asker = await createMember('member');
    const other = await createMember('other');
    const sessionId = await createSession(testDb.db, { ownerUserId: asker, title: 'Rainy Window' });
    const theirs = await createSession(testDb.db, { ownerUserId: other, title: 'Theirs' });

    const turn = await act(asker, [{ name: 'newMusicOff', input: {} }]);

    expect((await getActiveSession(testDb.db, { ownerUserId: asker }))!.sessionMode).toBe('repeat');
    expect(
      (await getSessionById(testDb.db, { ownerUserId: other, sessionId: theirs }))!.sessionMode,
    ).toBe('keep_going');
    expect(receipts(turn)).toEqual([
      { action: 'newMusicOff', session: { id: sessionId, name: 'Rainy Window' } },
    ]);
    expect(turn.results[0]).toMatch(/^Done: switched New music off for the Session "Rainy Window"/);
  });

  it('says New music is already off, and sends no receipt', async () => {
    const asker = await createMember('member');
    await createSession(testDb.db, { ownerUserId: asker, title: 'Loop', sessionMode: 'repeat' });

    const turn = await act(asker, [{ name: 'newMusicOff', input: {} }]);

    expect(turn.results[0]).toMatch(/new music is already off for the session "Loop"/i);
    expect(receipts(turn)).toEqual([]);
  });

  it('says there is no active Session, and leaves a stopped one as it is', async () => {
    const asker = await createMember('member');
    const stopped = await createSession(testDb.db, { ownerUserId: asker, status: 'stopped' });

    const turn = await act(asker, [{ name: 'newMusicOff', input: {} }]);

    expect(turn.results[0]).toMatch(/no active session/i);
    expect(receipts(turn)).toEqual([]);
    expect(
      (await getSessionById(testDb.db, { ownerUserId: asker, sessionId: stopped }))!.sessionMode,
    ).toBe('keep_going');
  });
});

describe.skipIf(skip)('one message to the Assistant', () => {
  it('leads to at most three Library actions: the fourth is an error and changes nothing', async () => {
    const asker = await createMember('member');

    const turn = await act(
      asker,
      ['One', 'Two', 'Three', 'Four'].map((name) => ({ name: 'createPlaylist', input: { name } })),
    );

    const created = await playlistNamesOf(asker);
    expect(created).toHaveLength(3);
    expect(receipts(turn)).toHaveLength(3);
    expect(
      receipts(turn)
        .map((receipt) => 'playlist' in receipt && receipt.playlist.name)
        .sort(),
    ).toEqual([...created].sort());
    const refusals = turn.results.filter((result) => /already done 3 things/i.test(result));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/nothing was changed/i);
  });

  it('cannot undo: a value asking for the opposite is ignored', async () => {
    const asker = await createMember('member');
    const [trackId] = await seedTracks(asker, 'Night Drive');
    await setTrackFavorited(testDb.db, { ownerUserId: asker, trackId: trackId!, favorited: true });
    const playlist = await createPlaylist(testDb.db, { ownerUserId: asker, name: 'Running' });
    await setPlaylistLibraryPinned(testDb.db, {
      ownerUserId: asker,
      playlistId: playlist.id,
      pinned: true,
    });

    await act(asker, [
      { name: 'favoriteTrack', input: { trackId, favorited: false } },
      { name: 'pinPlaylist', input: { playlistId: playlist.id, pinned: false } },
    ]);

    expect(await favoritesOf(asker)).toEqual(['Night Drive']);
    const [stillPinned] = (await listPlaylists(testDb.db, { ownerUserId: asker })).filter(
      ({ kind }) => kind === 'user',
    );
    expect(stillPinned!.pinnedAt).not.toBeNull();
  });

  it('is answered by an action alone when the model acts and writes nothing', async () => {
    const asker = await createMember('member');

    const turn = await act(asker, [{ name: 'createPlaylist', input: { name: 'Sunday' } }], {
      answer: [],
    });

    expect(turn.events).toEqual([
      { type: 'action', action: { status: 'done', receipt: receipts(turn)[0] } },
      { type: 'done' },
    ]);
    expect(await playlistNamesOf(asker)).toEqual(['Sunday']);
  });
});
