// What the Assistant's model is handed when it looks for the asking user's
// music: Sessions, Playlists and Tracks by what the app's search matches,
// Tracks by a line of their lyrics, the most recent of each, and the Tracks of
// one Session or Playlist. The route, the tools and the app's own search and
// Library functions run against a real database; a scripted model stands in
// for the text LLM.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPlaylistTracks,
  createPlaylist,
  setPlaylistLibraryPinned,
  setPlaylistLoungePinned,
  setPlaylistShared,
  setTrackFavorited,
  user,
  userProfiles,
} from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type SessionFixture,
  type TestDb,
} from '@liedmotif/db/testing';
import { askWithToolCall } from '../helpers/assistant-tool-turn';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

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

/** A stopped Session of `ownerUserId`, last active `activeDaysAgo` days ago, with one Track. */
async function seedStoppedSession(
  ownerUserId: string,
  title: string,
  activeDaysAgo: number,
  session: Partial<SessionFixture> = {},
): Promise<{ sessionId: string; trackId: string }> {
  const sessionId = await createSession(testDb.db, {
    ownerUserId,
    title,
    status: 'stopped',
    lastPlaybackReportAt: daysAgo(activeDaysAgo),
    ...session,
  });
  const trackId = await seedSessionTrack(testDb.db, ownerUserId, sessionId, {
    title: `${title} Take`,
  });
  return { sessionId, trackId };
}

/** A Playlist of `ownerUserId` holding, in this order, one new Track per title. */
async function seedPlaylist(
  ownerUserId: string,
  name: string,
  trackTitles: string[],
): Promise<{ playlistId: string; trackIds: string[] }> {
  const sessionId = await createSession(testDb.db, { ownerUserId, status: 'stopped' });
  const trackIds: string[] = [];
  for (const title of trackTitles) {
    trackIds.push(await seedSessionTrack(testDb.db, ownerUserId, sessionId, { title }));
  }
  const playlist = await createPlaylist(testDb.db, { ownerUserId, name });
  await addPlaylistTracks(testDb.db, { ownerUserId, playlistId: playlist.id, trackIds });
  return { playlistId: playlist.id, trackIds };
}

/** A sung Track of `ownerUserId` in a stopped Session named `sessionTitle`. */
async function seedSungTrack(
  ownerUserId: string,
  sessionTitle: string,
  title: string,
  lyrics: string,
  durationSeconds?: number,
): Promise<string> {
  const sessionId = await createSession(testDb.db, {
    ownerUserId,
    title: sessionTitle,
    status: 'stopped',
  });
  const generationRequestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId,
    providerJobId,
    title,
    vocalMode: 'vocal',
    lyrics,
    durationSeconds,
    audioStorageKey: `audio-${title}.mp3`,
  });
}

/** `userId` asks, the model calls `findMusic` with `input`; returns what the tool handed it. */
async function findMusic(userId: string, input: Record<string, unknown>): Promise<string> {
  holder.sessionUserId = userId;
  const { result } = await askWithToolCall(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    { name: 'findMusic', input },
  );
  return result;
}

/** `userId` asks, the model calls `listTracks` for one Session or Playlist. */
async function listTracks(userId: string, where: 'session' | 'playlist', id: string) {
  holder.sessionUserId = userId;
  const { result } = await askWithToolCall(
    POST,
    (llm) => {
      holder.llm = llm;
    },
    { name: 'listTracks', input: { in: where, id } },
  );
  return result;
}

/** The rows of a result: every line that names one thing by its id. */
const rows = (result: string) => result.split('\n').filter((line) => line.includes('(id '));

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('assistant-finds-music-test');
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

describe.skipIf(skip)('the Assistant asked to find Sessions', () => {
  it('lists the most recent first, the active one on top, each with its id and when it was last active', async () => {
    const asker = await createMember('member-1');
    const older = await seedStoppedSession(asker, 'Rainy Window', 7);
    const newer = await seedStoppedSession(asker, 'Deep Focus', 1);
    const active = await createSession(testDb.db, { ownerUserId: asker, title: 'Night Run' });

    const result = await findMusic(asker, { kind: 'session' });

    expect(rows(result)).toEqual([
      `- "Night Run" (id ${active}) · active now`,
      `- "Deep Focus" (id ${newer.sessionId}) · last active yesterday`,
      `- "Rainy Window" (id ${older.sessionId}) · last active 7 days ago`,
    ]);
    expect(result).not.toMatch(/more exist/i);
  });

  it('searches as the app does: a name first, and it says what matched when that was not the name', async () => {
    const asker = await createMember('member-1');
    const byName = await seedStoppedSession(asker, 'Rainy Window', 7);
    const byPrompt = await seedStoppedSession(asker, 'Grey Morning', 2, {
      userPrompt: 'soft rainy afternoon piano',
    });
    await seedStoppedSession(asker, 'Deep Focus', 1);

    const result = await findMusic(asker, { kind: 'session', query: 'rainy' });

    expect(rows(result)).toEqual([
      `- "Rainy Window" (id ${byName.sessionId}) · last active 7 days ago`,
      `- "Grey Morning" (id ${byPrompt.sessionId}) · last active 2 days ago · prompt: "soft rainy afternoon piano"`,
    ]);
  });

  it('says so when nothing matches', async () => {
    const asker = await createMember('member-1');
    await seedStoppedSession(asker, 'Deep Focus', 1);

    expect(await findMusic(asker, { kind: 'session', query: 'lighthouse' })).toBe(
      'No Session matches "lighthouse".',
    );
  });
});

describe.skipIf(skip)('the Assistant asked to find Playlists', () => {
  it('lists them as the Library does, Favorites first, each with its id and Track count', async () => {
    const asker = await createMember('member-1');
    const sunday = await seedPlaylist(asker, 'Sunday', ['Slow Coffee']);
    const running = await seedPlaylist(asker, 'Running', ['Night Drive', 'Open Road']);

    const result = await findMusic(asker, { kind: 'playlist' });

    const [favorites, ...others] = rows(result);
    expect(favorites).toMatch(/^- "Favorites" \(id [0-9a-f-]{36}\) · 0 Tracks$/);
    expect(others).toEqual([
      `- "Running" (id ${running.playlistId}) · 2 Tracks`,
      `- "Sunday" (id ${sunday.playlistId}) · 1 Track`,
    ]);
  });

  it('searches names and the Tracks inside, and names the owner of one pinned from the Lounge', async () => {
    const asker = await createMember('member-1');
    const owner = await createMember('member-2');
    const byName = await seedPlaylist(asker, 'Night Shift', ['Slow Coffee']);
    const byTrack = await seedPlaylist(asker, 'Running', ['Night Drive', 'Open Road']);
    const pinned = await seedPlaylist(owner, 'Night Owls', ['Moonlit']);
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: pinned.playlistId,
      audience: { kind: 'everyone' },
    });
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: asker,
      playlistId: pinned.playlistId,
      pinned: true,
    });

    const result = await findMusic(asker, { kind: 'playlist', query: 'night' });

    expect(rows(result).sort()).toEqual(
      [
        `- "Night Shift" (id ${byName.playlistId}) · 1 Track`,
        `- "Night Owls" (id ${pinned.playlistId}) · 1 Track · shared by "member-2"`,
        `- "Running" (id ${byTrack.playlistId}) · 2 Tracks · tracks: "Night Drive"`,
      ].sort(),
    );
  });
});

describe.skipIf(skip)('the Assistant asked to find Tracks', () => {
  it('lists the most recently generated first, each with its id and its Session', async () => {
    const asker = await createMember('member-1');
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Deep Focus',
      status: 'stopped',
    });
    const older = await seedSessionTrack(testDb.db, asker, sessionId, {
      title: 'First Light',
      createdAt: daysAgo(2),
    });
    const newer = await seedSessionTrack(testDb.db, asker, sessionId, {
      title: 'Night Drive',
      createdAt: daysAgo(1),
    });

    const result = await findMusic(asker, { kind: 'track' });

    expect(rows(result)).toEqual([
      `- "Night Drive" (id ${newer}) · Session "Deep Focus"`,
      `- "First Light" (id ${older}) · Session "Deep Focus"`,
    ]);
  });

  it('reads the saved Tracks or the favorites when asked for that list', async () => {
    const asker = await createMember('member-1');
    const { trackIds } = await seedPlaylist(asker, 'Running', ['Night Drive', 'Open Road']);
    const sessionId = await createSession(testDb.db, { ownerUserId: asker, status: 'stopped' });
    await seedSessionTrack(testDb.db, asker, sessionId, { title: 'Never Kept' });
    await setTrackFavorited(testDb.db, {
      ownerUserId: asker,
      trackId: trackIds[1]!,
      favorited: true,
    });

    const saved = await findMusic(asker, { kind: 'track', list: 'saved' });
    const favorites = await findMusic(asker, { kind: 'track', list: 'favorites' });

    expect(rows(saved)).toHaveLength(2);
    expect(saved).toContain('"Night Drive"');
    expect(saved).toContain('"Open Road"');
    expect(saved).not.toContain('Never Kept');
    expect(rows(favorites)).toHaveLength(1);
    expect(favorites).toContain(`"Open Road" (id ${trackIds[1]})`);
  });

  it('says so when a list is empty', async () => {
    const asker = await createMember('member-1');

    expect(await findMusic(asker, { kind: 'track', list: 'favorites' })).toBe(
      'There are no Tracks in favorites.',
    );
  });

  it('searches titles, and says what matched when that was not the title', async () => {
    const asker = await createMember('member-1');
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Deep Focus',
      status: 'stopped',
    });
    const byTitle = await seedSessionTrack(testDb.db, asker, sessionId, { title: 'Night Drive' });
    const byTag = await seedSessionTrack(testDb.db, asker, sessionId, {
      title: 'Open Road',
      genreTags: ['night-jazz'],
    });
    await seedSessionTrack(testDb.db, asker, sessionId, { title: 'First Light' });

    const result = await findMusic(asker, { kind: 'track', query: 'night' });

    expect(rows(result)).toEqual([
      `- "Night Drive" (id ${byTitle}) · Session "Deep Focus"`,
      `- "Open Road" (id ${byTag}) · Session "Deep Focus" · tags: "night-jazz"`,
    ]);
  });

  it('finds a Track by a line of its lyrics and returns that line, not the whole text', async () => {
    const asker = await createMember('member-1');
    const sung = await seedSungTrack(
      asker,
      'Harbour Songs',
      'Salt and Stone',
      [
        'We left the harbour before the morning bell rang twice over the water',
        'The old lighthouse keeps a candle burning for the boats that never came',
        'And every winter the gulls come back to count the names upon the wall',
        'Nobody sings the last verse anymore because the choir went home',
      ].join('\n'),
    );
    await seedSungTrack(asker, 'Other Songs', 'Lighthouse', 'A song about the open sea');

    const result = await findMusic(asker, { kind: 'track', query: 'lighthouse', lyrics: true });

    expect(rows(result)).toHaveLength(1);
    expect(rows(result)[0]).toMatch(
      new RegExp(
        `^- "Salt and Stone" \\(id ${sung}\\) · Session "Harbour Songs" · lyrics: ".*The old lighthouse keeps a candle.*"$`,
      ),
    );
    expect(result).not.toContain('We left the harbour');
    expect(result).not.toContain('Nobody sings the last verse');
  });

  it('searches lyrics whatever kind was asked for, because only Tracks have them', async () => {
    const asker = await createMember('member-1');
    const sung = await seedSungTrack(asker, 'Harbour Songs', 'Salt and Stone', 'The lighthouse');

    const result = await findMusic(asker, { kind: 'session', query: 'lighthouse', lyrics: true });

    expect(result).toContain('Tracks with "lighthouse" in their lyrics:');
    expect(rows(result)).toEqual([
      `- "Salt and Stone" (id ${sung}) · Session "Harbour Songs" · lyrics: "The lighthouse"`,
    ]);
  });

  it('asks for more to search with instead of searching for a single character', async () => {
    const asker = await createMember('member-1');
    const sessionId = await createSession(testDb.db, { ownerUserId: asker, status: 'stopped' });
    await seedSessionTrack(testDb.db, asker, sessionId, { title: 'Night Drive' });

    expect(await findMusic(asker, { kind: 'track', query: ' n ' })).toBe(
      'A search needs at least 2 characters.',
    );
    expect(await findMusic(asker, { kind: 'track', lyrics: true, query: null })).toBe(
      'A search needs at least 2 characters.',
    );
  });
});

describe.skipIf(skip)('what the Assistant finds', () => {
  it("is the asker's own: another user's private Session, Playlist and Track are not found", async () => {
    const asker = await createMember('member-1');
    const owner = await createMember('member-2');
    await seedStoppedSession(owner, 'Rainy Window', 1);
    await seedPlaylist(owner, 'Rainy Mix', ['Rainy Road']);
    await seedSungTrack(owner, 'Harbour Songs', 'Rainy Harbour', 'Rainy days at the lighthouse');

    expect(await findMusic(asker, { kind: 'session', query: 'rainy' })).toBe(
      'No Session matches "rainy".',
    );
    expect(await findMusic(asker, { kind: 'playlist', query: 'rainy' })).toBe(
      'No Playlist matches "rainy".',
    );
    expect(await findMusic(asker, { kind: 'track', query: 'rainy' })).toBe(
      'No Track matches "rainy".',
    );
    expect(await findMusic(asker, { kind: 'track', query: 'lighthouse', lyrics: true })).toBe(
      'No Track has "lighthouse" in its lyrics.',
    );
    expect(await findMusic(asker, { kind: 'session' })).toBe('There are no Sessions yet.');
    expect(await findMusic(asker, { kind: 'track' })).toBe('There are no Tracks in history.');
    expect(rows(await findMusic(asker, { kind: 'playlist' }))).toHaveLength(1);
    // The owner still finds all of it.
    expect(await findMusic(owner, { kind: 'session', query: 'rainy' })).toContain('"Rainy Window"');
    expect(await findMusic(owner, { kind: 'track', query: 'rainy' })).toContain('"Rainy Harbour"');
  });

  it('lists at most ten of the most recent and says that more exist', async () => {
    const asker = await createMember('member-1');
    for (let i = 1; i <= 12; i += 1) await seedStoppedSession(asker, `Session ${i}`, i);

    const sessions = await findMusic(asker, { kind: 'session' });
    const tracks = await findMusic(asker, { kind: 'track' });

    for (const result of [sessions, tracks]) {
      expect(rows(result)).toHaveLength(10);
      expect(result.split('\n').at(-1)).toBe('More exist: only the first 10 are listed.');
    }
    expect(rows(sessions)[0]).toContain('"Session 1"');
  });

  it('holds the cap for Playlists too, where pinned ones come on top of a page', async () => {
    const asker = await createMember('member-1');
    for (let i = 1; i <= 12; i += 1) {
      const { playlistId } = await seedPlaylist(asker, `Mix ${i}`, []);
      await setPlaylistLibraryPinned(testDb.db, { ownerUserId: asker, playlistId, pinned: true });
    }

    const result = await findMusic(asker, { kind: 'playlist' });

    expect(rows(result)).toHaveLength(10);
    expect(result.split('\n').at(-1)).toBe('More exist: only the first 10 are listed.');
  });

  it('lists at most ten matches of a search and says how many there are', async () => {
    const asker = await createMember('member-1');
    for (let i = 1; i <= 12; i += 1) await seedStoppedSession(asker, `Rainy ${i}`, i);

    const result = await findMusic(asker, { kind: 'session', query: 'rainy' });

    expect(rows(result)).toHaveLength(10);
    expect(result.split('\n').at(-1)).toBe('12 match: only the first 10 are listed.');
  });
});

describe.skipIf(skip)('the Assistant asked for the Tracks of one Session or Playlist', () => {
  it('lists the Tracks of a Session in the order they were generated', async () => {
    const asker = await createMember('member-1');
    const sessionId = await createSession(testDb.db, {
      ownerUserId: asker,
      title: 'Deep Focus',
      status: 'stopped',
    });
    const second = await seedSessionTrack(testDb.db, asker, sessionId, {
      title: 'Night Drive',
      createdAt: daysAgo(1),
    });
    const first = await seedSessionTrack(testDb.db, asker, sessionId, {
      title: 'First Light',
      createdAt: daysAgo(2),
    });

    const result = await listTracks(asker, 'session', sessionId);

    expect(result.split('\n')).toEqual([
      `Session "Deep Focus" (id ${sessionId}), 2 Tracks in order:`,
      `1. "First Light" (id ${first})`,
      `2. "Night Drive" (id ${second})`,
    ]);
  });

  it("lists the Tracks of a Playlist in the Playlist's own order, with how long each is", async () => {
    const asker = await createMember('member-1');
    const sung = await seedSungTrack(
      asker,
      'Harbour Songs',
      'Salt and Stone',
      'The lighthouse',
      222,
    );
    const { playlistId, trackIds } = await seedPlaylist(asker, 'Running', ['Open Road']);
    await addPlaylistTracks(testDb.db, { ownerUserId: asker, playlistId, trackIds: [sung] });

    const result = await listTracks(asker, 'playlist', playlistId);

    expect(result.split('\n')).toEqual([
      `Playlist "Running" (id ${playlistId}), 2 Tracks in order:`,
      `1. "Open Road" (id ${trackIds[0]})`,
      `2. "Salt and Stone" (id ${sung}) · 3:42`,
    ]);
  });

  it("lists another user's Playlist the asker can see in the Lounge", async () => {
    const asker = await createMember('member-1');
    const owner = await createMember('member-2');
    const { playlistId, trackIds } = await seedPlaylist(owner, 'Night Owls', ['Moonlit']);
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId,
      audience: { kind: 'everyone' },
    });

    const result = await listTracks(asker, 'playlist', playlistId);

    expect(result.split('\n')).toEqual([
      `Playlist "Night Owls" (id ${playlistId}), 1 Track in order:`,
      `1. "Moonlit" (id ${trackIds[0]})`,
    ]);
  });

  it('says so when there are no Tracks', async () => {
    const asker = await createMember('member-1');
    const { playlistId } = await seedPlaylist(asker, 'Empty', []);

    expect(await listTracks(asker, 'playlist', playlistId)).toBe(
      `Playlist "Empty" (id ${playlistId}) has no Tracks.`,
    );
  });

  it('answers an id the asker cannot see like one that does not exist', async () => {
    const asker = await createMember('member-1');
    const owner = await createMember('member-2');
    const theirs = await seedStoppedSession(owner, 'Private Session', 1);
    const theirPlaylist = await seedPlaylist(owner, 'Private Mix', ['Hidden Song']);
    const nobodys = '00000000-0000-4000-8000-000000000000';

    for (const id of [theirs.sessionId, nobodys, 'not-an-id']) {
      expect(await listTracks(asker, 'session', id)).toBe('No Session with that id.');
    }
    for (const id of [theirPlaylist.playlistId, nobodys, 'not-an-id']) {
      expect(await listTracks(asker, 'playlist', id)).toBe('No Playlist with that id.');
    }
    // The owner reads both.
    expect(await listTracks(owner, 'session', theirs.sessionId)).toContain(
      '"Private Session Take"',
    );
    expect(await listTracks(owner, 'playlist', theirPlaylist.playlistId)).toContain(
      '"Hidden Song"',
    );
  });

  it('lists at most thirty Tracks and says how many there are', async () => {
    const asker = await createMember('member-1');
    const titles = Array.from({ length: 32 }, (_, i) => `Track ${i + 1}`);
    const { playlistId } = await seedPlaylist(asker, 'Long One', titles);

    const result = await listTracks(asker, 'playlist', playlistId);

    expect(rows(result).slice(1)).toHaveLength(30);
    expect(result).toContain(`Playlist "Long One" (id ${playlistId}), 32 Tracks in order:`);
    expect(result).toContain('30. "Track 30"');
    expect(result.split('\n').at(-1)).toBe('Only the first 30 are listed.');
  });
});
