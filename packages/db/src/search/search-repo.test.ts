import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions } from '../schema';
import {
  connectTestDb,
  createCoverImage,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import {
  addPlaylistTracks,
  applyTrackMemberships,
  createPlaylist,
  ensureFavoritesPlaylist,
  setPlaylistLoungePinned,
  setPlaylistShared,
} from '../playlists';
import { MAX_SEARCH_QUERY_LENGTH, type SearchSort } from '@liedmotif/shared';
import { searchPlaylists, searchSessions, searchTracks } from './search-repo';

// The ranked, capped retrieval core (spec: search-retrieval-core). Rank is
// (exactness, fieldWeight, createdAt desc, id); counts are exact and
// independent of the cap; every row explains itself with the winning field.

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
  testDb = await connectTestDb('search-repo-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
});

/** Text no test query ever matches, so fixture defaults cannot leak into results. */
const NEUTRAL_PROMPT = 'untouched seed material';
const NEUTRAL_SESSION_TITLE = 'Quiet Corner';

interface TrackSeed {
  title?: string | null;
  genreTags?: string[];
  mood?: string | null;
  activity?: string | null;
  prompt?: string;
  lyrics?: string | null;
  status?: 'pending' | 'streamable' | 'ready' | 'rejected' | 'deleted' | 'failed';
  createdAt?: Date;
  audioStorageKey?: string;
  sessionId?: string;
  sessionTitle?: string;
}

async function seedTrack(ownerUserId: string, seed: TrackSeed = {}): Promise<string> {
  const sessionId =
    seed.sessionId ??
    (await createSession(testDb.db, {
      ownerUserId,
      status: 'stopped',
      title: seed.sessionTitle ?? NEUTRAL_SESSION_TITLE,
    }));
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    prompt: seed.prompt ?? NEUTRAL_PROMPT,
    title: seed.title ?? null,
    genreTags: seed.genreTags ?? [],
    mood: seed.mood ?? null,
    activity: seed.activity ?? null,
    lyrics: seed.lyrics ?? null,
    status: seed.status ?? 'ready',
    ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    ...(seed.audioStorageKey ? { audioStorageKey: seed.audioStorageKey } : {}),
  });
}

function baseArgs(ownerUserId: string, query: string) {
  return { ownerUserId, query, limit: 50, sort: 'relevance' as const };
}

describe.skipIf(skip)('searchTracks', () => {
  it('matches every field in the shared track surface', async () => {
    const owner = await createUser(testDb.db);
    const byTitle = await seedTrack(owner, { title: 'Rainy Piano' });
    const byTag = await seedTrack(owner, { title: 'Tag Carrier', genreTags: ['rainwave'] });
    const byMood = await seedTrack(owner, { title: 'Mood Carrier', mood: 'rainy' });
    const byActivity = await seedTrack(owner, { title: 'Act Carrier', activity: 'rain running' });
    const byPrompt = await seedTrack(owner, {
      title: 'Prompt Carrier',
      prompt: 'lofi for rainy nights',
    });
    const bySession = await seedTrack(owner, {
      title: 'Session Carrier',
      sessionTitle: 'Rain Garden',
    });

    const { items, matchCount } = await searchTracks(testDb.db, baseArgs(owner, 'rain'));
    expect(matchCount).toBe(6);
    expect(items[0]!.createdAt).toBeInstanceOf(Date);
    const fieldById = new Map(items.map((t) => [t.id, t.match.field]));
    expect(fieldById.get(byTitle)).toBe('name');
    expect(fieldById.get(byTag)).toBe('tags');
    expect(fieldById.get(byMood)).toBe('tags');
    expect(fieldById.get(byActivity)).toBe('tags');
    expect(fieldById.get(byPrompt)).toBe('prompt');
    expect(fieldById.get(bySession)).toBe('session');
  });

  it('ranks exactness tiers: whole field, starts-with, word-start, anywhere', async () => {
    const owner = await createUser(testDb.db);
    const anywhere = await seedTrack(owner, { title: 'Unfocused' });
    const wordStart = await seedTrack(owner, { title: 'Deep Focus' });
    const prefix = await seedTrack(owner, { title: 'Focus Flow' });
    const whole = await seedTrack(owner, { title: 'Focus' });

    const { items } = await searchTracks(testDb.db, baseArgs(owner, 'focus'));
    expect(items.map((t) => t.id)).toEqual([whole, prefix, wordStart, anywhere]);
    expect(items.map((t) => t.match.exactness)).toEqual([0, 1, 2, 3]);
  });

  it('ranks field tiers name, tags, prompt, session at equal exactness', async () => {
    const owner = await createUser(testDb.db);
    const bySession = await seedTrack(owner, {
      title: 'D Carrier',
      sessionTitle: 'somezephyrsession',
    });
    const byPrompt = await seedTrack(owner, {
      title: 'C Carrier',
      prompt: 'contains midzephyrword only',
    });
    const byTag = await seedTrack(owner, { title: 'B Carrier', genreTags: ['neozephyrwave'] });
    const byTitle = await seedTrack(owner, { title: 'threezephyrfour' });

    const { items } = await searchTracks(testDb.db, baseArgs(owner, 'zephyr'));
    expect(items.map((t) => t.id)).toEqual([byTitle, byTag, byPrompt, bySession]);
  });

  it('breaks rank ties by createdAt desc', async () => {
    const owner = await createUser(testDb.db);
    const older = await seedTrack(owner, {
      title: 'Twin Ember',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = await seedTrack(owner, {
      title: 'Twin Ember',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const { items } = await searchTracks(testDb.db, baseArgs(owner, 'twin ember'));
    expect(items.map((t) => t.id)).toEqual([newer, older]);
  });

  it('caps rows while matchCount reports the true total', async () => {
    const owner = await createUser(testDb.db);
    for (let i = 0; i < 7; i += 1) await seedTrack(owner, { title: `Cap Study ${i}` });

    const capped = await searchTracks(testDb.db, { ...baseArgs(owner, 'cap study'), limit: 5 });
    expect(capped.items).toHaveLength(5);
    expect(capped.matchCount).toBe(7);

    const full = await searchTracks(testDb.db, baseArgs(owner, 'cap study'));
    expect(full.items).toHaveLength(7);
  });

  it('treats LIKE and regex metacharacters as literal text', async () => {
    const owner = await createUser(testDb.db);
    const literal = await seedTrack(owner, { title: '100% Focus' });
    await seedTrack(owner, { title: '100 percent focus' });
    const cpp = await seedTrack(owner, { title: 'C++ Study Mix' });

    const percent = await searchTracks(testDb.db, baseArgs(owner, '100%'));
    expect(percent.items.map((t) => t.id)).toEqual([literal]);

    const plus = await searchTracks(testDb.db, baseArgs(owner, 'c++'));
    expect(plus.items.map((t) => t.id)).toEqual([cpp]);
  });

  describe('genre tags, typed as the card shows them', () => {
    it.each([
      ['drum & bass', 'drum-and-bass'],
      ['drum and bass', 'drum-and-bass'],
      ['DRUM AND BASS', 'drum-and-bass'],
      ['deep house', 'deep-house'],
      ['lo-fi', 'lofi'],
      ['lo fi', 'lofi'],
      ['lofi', 'lo-fi'],
      ['r&b', 'r-and-b'],
      ['r and b', 'r&b'],
    ])('%s finds %s, naming the tag', async (query, tag) => {
      const owner = await createUser(testDb.db);
      const track = await seedTrack(owner, { title: 'Carrier', genreTags: ['jazz', tag] });
      await seedTrack(owner, { title: 'Other', genreTags: ['jazz'] });

      const { items, matchCount } = await searchTracks(testDb.db, baseArgs(owner, query));

      expect(items.map((t) => t.id)).toEqual([track]);
      expect(matchCount).toBe(1);
      expect(items[0]!.match.field).toBe('tags');
      expect(items[0]!.match.snippet).toBe(tag);
    });

    it.each([
      ['man', 'drum-and-bass'],
      ['pro', 'pop-rock'],
      ['pho', 'deep-house'],
      ['r b', 'urban'],
      ['eep house', 'deep-house'],
    ])('%s does not find %s: the match starts at a word of the tag', async (query, tag) => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, { title: 'Carrier', genreTags: [tag] });

      const { matchCount } = await searchTracks(testDb.db, baseArgs(owner, query));

      expect(matchCount).toBe(0);
    });

    it.each(['&&', '--', '& -', '%%', '__', '\\\\', '((', '[['])(
      '%s has no letters to compare, so it matches no tag',
      async (query) => {
        const owner = await createUser(testDb.db);
        await seedTrack(owner, { title: 'Carrier', genreTags: ['drum-and-bass', 'lo-fi'] });

        const { matchCount } = await searchTracks(testDb.db, baseArgs(owner, query));

        expect(matchCount).toBe(0);
      },
    );

    it('still matches a punctuation-only query against a tag literally holding it', async () => {
      const owner = await createUser(testDb.db);
      const literal = await seedTrack(owner, { title: 'Carrier', genreTags: ['r&&b'] });
      await seedTrack(owner, { title: 'Other', genreTags: ['r-and-b'] });

      const { items } = await searchTracks(testDb.db, baseArgs(owner, '&&'));

      expect(items.map((t) => t.id)).toEqual([literal]);
    });

    it.each(['dr%m', 'dr_m', 'd.*m', 'dr[aeiou]m', 'dr(m'])(
      '%s is not a pattern: it matches nothing a wildcard would',
      async (query) => {
        const owner = await createUser(testDb.db);
        await seedTrack(owner, { title: 'Carrier', genreTags: ['drum-and-bass'] });

        const { matchCount } = await searchTracks(testDb.db, baseArgs(owner, query));

        expect(matchCount).toBe(0);
      },
    );

    it.each(['drum (and) bass', 'drum_and_bass', 'drum%and%bass', 'drum\\and\\bass', '[drum and'])(
      '%s ignores its metacharacters as punctuation',
      async (query) => {
        const owner = await createUser(testDb.db);
        const track = await seedTrack(owner, { title: 'Carrier', genreTags: ['drum-and-bass'] });

        const { items } = await searchTracks(testDb.db, baseArgs(owner, query));

        expect(items.map((t) => t.id)).toEqual([track]);
      },
    );

    it('survives the longest query the contracts allow, every "&" expanded', async () => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, { title: 'Carrier', genreTags: ['drum-and-bass'] });

      const { matchCount } = await searchTracks(
        testDb.db,
        baseArgs(owner, 'a&'.repeat(MAX_SEARCH_QUERY_LENGTH / 2)),
      );

      expect(matchCount).toBe(0);
    });

    it('ranks below every literal hit, which keeps its own rank and field', async () => {
      const owner = await createUser(testDb.db);
      const looseOnly = await seedTrack(owner, { title: 'Loose', genreTags: ['deep-house'] });
      const literalTag = await seedTrack(owner, { title: 'Tag', genreTags: ['deep house'] });
      const literalPrompt = await seedTrack(owner, {
        title: 'Prompt',
        genreTags: ['deep-house'],
        prompt: 'xdeep house groove',
      });
      const literalSession = await seedTrack(owner, {
        title: 'Session',
        genreTags: ['deep-house'],
        sessionTitle: 'xdeep house night',
      });

      const { items } = await searchTracks(testDb.db, baseArgs(owner, 'deep house'));

      expect(
        items.map((t) => ({ id: t.id, field: t.match.field, exactness: t.match.exactness })),
      ).toEqual([
        { id: literalTag, field: 'tags', exactness: 0 },
        { id: literalPrompt, field: 'prompt', exactness: 3 },
        { id: literalSession, field: 'session', exactness: 3 },
        { id: looseOnly, field: 'tags', exactness: 4 },
      ]);
    });

    it('names the literal tag when a Track also carries a punctuation-only one', async () => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, { title: 'Carrier', genreTags: ['a-deep-house', 'x deep house'] });

      const { items } = await searchTracks(testDb.db, baseArgs(owner, 'deep house'));

      expect(items[0]!.match).toMatchObject({ exactness: 2, snippet: 'x deep house' });
    });

    it('cuts a tag too long to show whole without locating the query in it', async () => {
      const owner = await createUser(testDb.db);
      const tag = `deep-house-${'x'.repeat(120)}`;
      await seedTrack(owner, { title: 'Carrier', genreTags: [tag] });

      const { items } = await searchTracks(testDb.db, baseArgs(owner, 'deep house'));

      expect(items[0]!.match.snippet.startsWith('deep-house-')).toBe(true);
    });

    it('leaves every other Track field matching only as stored', async () => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, {
        title: 'deep-house',
        mood: 'deep-house',
        activity: 'deep-house',
        prompt: 'deep-house',
        lyrics: 'deep-house',
        sessionTitle: 'deep-house',
      });

      const tracks = await searchTracks(testDb.db, baseArgs(owner, 'deep house'));
      const lyrics = await searchTracks(testDb.db, {
        ...baseArgs(owner, 'deep house'),
        lyricsOnly: true,
      });

      expect(tracks.matchCount).toBe(0);
      // No exact lyrics hit: the Track comes back only as a close match.
      expect(lyrics.closeMatches).toBe(true);
      expect(lyrics.items[0]!.match.snippet).toBe('deep-house');
    });
  });

  it('keeps every candidate the ranking scores, on a query too short to index', async () => {
    // The eligibility prefilter must admit a row whose ONLY hit is in a
    // many-valued field or a joined one, and must not gate on a query long
    // enough for trigrams — the minimum query is two characters, which yields
    // none, so an index-length shortcut would return an empty result set.
    const owner = await createUser(testDb.db);
    const byTag = await seedTrack(owner, { title: 'Tag Carrier', genreTags: ['ok'] });
    const bySession = await seedTrack(owner, {
      title: 'Session Carrier',
      sessionTitle: 'Ok Corral',
    });
    await seedTrack(owner, { title: 'No Hit Here' });

    const { items, matchCount } = await searchTracks(testDb.db, baseArgs(owner, 'ok'));
    expect(matchCount).toBe(2);
    expect(new Set(items.map((t) => t.id))).toEqual(new Set([byTag, bySession]));
  });

  it('never returns another owner rows', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const mine = await seedTrack(owner, { title: 'Shared Words' });
    await seedTrack(other, { title: 'Shared Words' });

    const { items, matchCount } = await searchTracks(testDb.db, baseArgs(owner, 'shared words'));
    expect(items.map((t) => t.id)).toEqual([mine]);
    expect(matchCount).toBe(1);
  });

  it('excludes rejected and deleted tracks but keeps unplayable ones', async () => {
    const owner = await createUser(testDb.db);
    await seedTrack(owner, { title: 'Gate Check A', status: 'rejected' });
    await seedTrack(owner, { title: 'Gate Check B', status: 'deleted' });
    const pending = await seedTrack(owner, { title: 'Gate Check C', status: 'pending' });
    const ready = await seedTrack(owner, {
      title: 'Gate Check D',
      audioStorageKey: 'search/gate-check-d.mp3',
    });

    const { items } = await searchTracks(testDb.db, baseArgs(owner, 'gate check'));
    expect(items.map((t) => t.id).sort()).toEqual([pending, ready].sort());
    const pendingRow = items.find((t) => t.id === pending)!;
    expect(pendingRow.hasPlayableAudio).toBe(false);
    expect(pendingRow.hasPlayed).toBe(false);
  });

  it('sorts by newest and by title with nulls last', async () => {
    const owner = await createUser(testDb.db);
    const second = await seedTrack(owner, {
      title: 'B Orbit',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const first = await seedTrack(owner, {
      title: 'A Orbit',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const untitled = await seedTrack(owner, {
      prompt: 'about orbit mechanics',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });

    const newest = await searchTracks(testDb.db, { ...baseArgs(owner, 'orbit'), sort: 'newest' });
    expect(newest.items.map((t) => t.id)).toEqual([untitled, first, second]);

    const byTitle = await searchTracks(testDb.db, { ...baseArgs(owner, 'orbit'), sort: 'title' });
    expect(byTitle.items.map((t) => t.id)).toEqual([first, second, untitled]);
  });

  it('windows a long winning text into a bounded snippet', async () => {
    const owner = await createUser(testDb.db);
    const padding = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ');
    await seedTrack(owner, { prompt: `${padding} glimmerhook ${padding}` });

    const { items } = await searchTracks(testDb.db, baseArgs(owner, 'glimmerhook'));
    expect(items).toHaveLength(1);
    const { snippet } = items[0]!.match;
    expect(snippet).toContain('glimmerhook');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(104);
  });

  it('lyrics mode matches lyric text alone and skips lyric-less tracks', async () => {
    const owner = await createUser(testDb.db);
    const sung = await seedTrack(owner, {
      title: 'Sunset Drive',
      lyrics: 'walking in the rain tonight',
    });
    await seedTrack(owner, { title: 'Rain Dance' });
    await seedTrack(owner, { title: 'Third Wheel', lyrics: 'blue skies forever' });

    const { items, matchCount } = await searchTracks(testDb.db, {
      ...baseArgs(owner, 'rain'),
      lyricsOnly: true,
    });
    expect(matchCount).toBe(1);
    expect(items.map((t) => t.id)).toEqual([sung]);
    expect(items[0]!.match.field).toBe('lyrics');
    expect(items[0]!.match.snippet).toContain('rain');
  });

  describe('lyrics mode close matches, when the exact words find nothing', () => {
    const lyricsSearch = (ownerUserId: string, query: string, sort: SearchSort = 'relevance') =>
      searchTracks(testDb.db, { ...baseArgs(ownerUserId, query), sort, lyricsOnly: true });

    it('finds a line with one typo first, its closest line as the match', async () => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, { title: 'Harbor Lights', lyrics: 'the tide rolls in at dawn' });
      const moon = await seedTrack(owner, {
        title: 'Vier im Mondorbit',
        lyrics: 'wir starten heute Nacht\nzu viert auf dem Mond\nund niemand schaut zu',
      });

      const result = await lyricsSearch(owner, 'zu viert auf dem mnod');
      expect(result.closeMatches).toBe(true);
      expect(result.items[0]!.id).toBe(moon);
      expect(result.items[0]!.title).toBe('Vier im Mondorbit');
      expect(result.items[0]!.match.field).toBe('lyrics');
      expect(result.items[0]!.match.snippet).toBe('zu viert auf dem Mond');
      expect(result.matchCount).toBe(result.items.length);
    });

    it('still finds a short line with two typos among the close matches', async () => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, { title: 'Harbor Lights', lyrics: 'the tide rolls in at dawn' });
      const moon = await seedTrack(owner, {
        title: 'Vier im Mondorbit',
        lyrics: 'zu viert auf dem Mond',
      });

      const result = await lyricsSearch(owner, 'zu veirt auf dem mnod');
      expect(result.closeMatches).toBe(true);
      expect(result.items.map((t) => t.id)).toContain(moon);
    });

    it('keeps an exact hit exact, with no close match mixed in', async () => {
      const owner = await createUser(testDb.db);
      const moon = await seedTrack(owner, {
        title: 'Vier im Mondorbit',
        lyrics: 'zu viert auf dem Mond',
      });
      await seedTrack(owner, { title: 'Near Miss', lyrics: 'zu viert auf dem Mund' });

      const result = await lyricsSearch(owner, 'auf dem Mond');
      expect(result.closeMatches).toBe(false);
      expect(result.items.map((t) => t.id)).toEqual([moon]);
      expect(result.matchCount).toBe(1);
      expect(result.items[0]!.match.snippet).toBe('zu viert auf dem Mond');
    });

    it('returns nothing for a query sharing no spelling with any lyrics', async () => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, { title: 'Vier im Mondorbit', lyrics: 'zu viert auf dem Mond' });

      const result = await lyricsSearch(owner, 'xqj');
      expect(result).toEqual({ items: [], matchCount: 0, closeMatches: false });
    });

    it('offers only own Tracks with lyrics, never another owner private ones', async () => {
      const owner = await createUser(testDb.db);
      const other = await createUser(testDb.db);
      await seedTrack(owner, { title: 'zu viert auf dem Mond' });
      await seedTrack(owner, {
        title: 'Gone',
        lyrics: 'zu viert auf dem Mond',
        status: 'deleted',
      });
      await seedTrack(other, { title: 'Theirs', lyrics: 'zu viert auf dem Mond' });
      const mine = await seedTrack(owner, { title: 'Mine', lyrics: 'zu viert am Strand' });

      const result = await lyricsSearch(owner, 'zu viert auf dem mnod');
      expect(result.items.map((t) => t.id)).toEqual([mine]);
    });

    it('orders close matches closest first whatever the sort', async () => {
      const owner = await createUser(testDb.db);
      const moon = await seedTrack(owner, {
        title: 'Zebra',
        lyrics: 'zu viert auf dem Mond',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const beach = await seedTrack(owner, {
        title: 'Aardvark',
        lyrics: 'zu viert am Strand',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });

      for (const sort of ['relevance', 'newest', 'title'] as const) {
        const result = await lyricsSearch(owner, 'zu viert auf dem mnod', sort);
        expect(result.items.map((t) => t.id)).toEqual([moon, beach]);
      }
    });

    it('never falls back outside lyrics mode', async () => {
      const owner = await createUser(testDb.db);
      await seedTrack(owner, { title: 'Vier im Mondorbit', lyrics: 'zu viert auf dem Mond' });

      const result = await searchTracks(testDb.db, baseArgs(owner, 'zu viert auf dem mnod'));
      expect(result).toEqual({ items: [], matchCount: 0, closeMatches: false });
    });
  });
});

describe.skipIf(skip)('searchSessions', () => {
  it('matches every field in the session surface, including the active session', async () => {
    const owner = await createUser(testDb.db);
    const byTitle = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'active',
      title: 'Rainy Morning',
    });
    const byUserPrompt = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Second',
      userPrompt: 'rainy forty minute run',
    });
    const byStylePrompt = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Third',
      styleSnapshot: { stylePrompt: 'gentle rain textures' },
    });
    const bySnapshotTags = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Fourth',
      styleSnapshot: { genreTags: ['rainwave'] },
    });
    const bySnapshotMood = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Fifth',
      styleSnapshot: { mood: 'rainy' },
    });
    const bySnapshotActivity = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Sixth',
      styleSnapshot: { activity: 'rain walk' },
    });

    const { items, matchCount } = await searchSessions(testDb.db, baseArgs(owner, 'rain'));
    expect(matchCount).toBe(6);
    expect(items[0]!.lastActiveAt).toBeInstanceOf(Date);
    const fieldById = new Map(items.map((s) => [s.id, s.match.field]));
    expect(fieldById.get(byTitle)).toBe('name');
    expect(fieldById.get(byUserPrompt)).toBe('prompt');
    expect(fieldById.get(byStylePrompt)).toBe('prompt');
    expect(fieldById.get(bySnapshotTags)).toBe('tags');
    expect(fieldById.get(bySnapshotMood)).toBe('tags');
    expect(fieldById.get(bySnapshotActivity)).toBe('tags');
    expect(items.find((s) => s.id === byTitle)?.status).toBe('active');
  });

  describe('by Track title', () => {
    it('finds a Session through one of its Track titles and names that Track', async () => {
      const owner = await createUser(testDb.db);
      const session = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Second Wind',
      });
      await seedSessionTrack(testDb.db, owner, session, { title: 'Dry Spell' });
      await seedSessionTrack(testDb.db, owner, session, { title: 'Rain on Tin' });

      const { items, matchCount } = await searchSessions(testDb.db, baseArgs(owner, 'rain'));

      expect(matchCount).toBe(1);
      expect(items[0]!.id).toBe(session);
      expect(items[0]!.match.field).toBe('tracks');
      expect(items[0]!.match.snippet).toBe('Rain on Tin');
    });

    it('ranks a Track-title hit between Tags and Prompt at equal exactness', async () => {
      const owner = await createUser(testDb.db);
      const byPrompt = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'First',
        userPrompt: 'rain',
      });
      const byTrack = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Second',
      });
      await seedSessionTrack(testDb.db, owner, byTrack, { title: 'Rain' });
      const byTag = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Third',
        styleSnapshot: { mood: 'rain' },
      });

      const { items } = await searchSessions(testDb.db, baseArgs(owner, 'rain'));

      expect(items.map((s) => s.id)).toEqual([byTag, byTrack, byPrompt]);
    });

    it.each([
      ['disliked', { dislikedAt: new Date() }],
      ['rejected', { status: 'rejected' as const }],
      ['deleted', { status: 'deleted' as const }],
      ['rejected from the Queue', { queueState: 'rejected' as const }],
      ['without playable audio', { playable: false }],
    ])('never matches on a Track that is %s', async (_label, track) => {
      const owner = await createUser(testDb.db);
      const session = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Second Wind',
      });
      await seedSessionTrack(testDb.db, owner, session, { title: 'Rain on Tin', ...track });

      const { matchCount } = await searchSessions(testDb.db, baseArgs(owner, 'rain'));

      expect(matchCount).toBe(0);
    });

    it('finds a Session by a genre only its Tracks carry, as its card shows it', async () => {
      const owner = await createUser(testDb.db);
      const session = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Second Wind',
        styleSnapshot: { genreTags: ['jazz'] },
      });
      await seedSessionTrack(testDb.db, owner, session, {
        title: 'Dry Spell',
        genreTags: ['lofi'],
      });

      const { items } = await searchSessions(testDb.db, baseArgs(owner, 'lofi'));

      expect(items.map((s) => s.id)).toEqual([session]);
      expect(items[0]!.match.field).toBe('tags');
      expect(items[0]!.match.snippet).toBe('lofi');
    });

    it('never matches the genre of a Track the Session does not list', async () => {
      const owner = await createUser(testDb.db);
      const session = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Second Wind',
      });
      await seedSessionTrack(testDb.db, owner, session, {
        title: 'Dry Spell',
        genreTags: ['lofi'],
        dislikedAt: new Date(),
      });

      const { matchCount } = await searchSessions(testDb.db, baseArgs(owner, 'lofi'));

      expect(matchCount).toBe(0);
    });

    it('finds a Session by a listed Track genre typed as the card shows it', async () => {
      const owner = await createUser(testDb.db);
      const session = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Second Wind',
      });
      await seedSessionTrack(testDb.db, owner, session, {
        title: 'Dry Spell',
        genreTags: ['drum-and-bass'],
      });

      const { items } = await searchSessions(testDb.db, baseArgs(owner, 'drum & bass'));

      expect(items.map((s) => s.id)).toEqual([session]);
      expect(items[0]!.match).toMatchObject({ field: 'tags', snippet: 'drum-and-bass' });
    });

    it('never matches the genre of a disliked Track, however it is typed', async () => {
      const owner = await createUser(testDb.db);
      const session = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Second Wind',
      });
      await seedSessionTrack(testDb.db, owner, session, {
        title: 'Dry Spell',
        genreTags: ['drum-and-bass'],
        dislikedAt: new Date(),
      });

      const { matchCount } = await searchSessions(testDb.db, baseArgs(owner, 'drum & bass'));

      expect(matchCount).toBe(0);
    });

    it('does not cross Sessions: only the Session holding the Track matches', async () => {
      const owner = await createUser(testDb.db);
      const holder = await createSession(testDb.db, {
        ownerUserId: owner,
        status: 'stopped',
        title: 'Holder',
      });
      await createSession(testDb.db, { ownerUserId: owner, status: 'stopped', title: 'Other' });
      await seedSessionTrack(testDb.db, owner, holder, { title: 'Rain on Tin' });

      const { items } = await searchSessions(testDb.db, baseArgs(owner, 'rain'));

      expect(items.map((s) => s.id)).toEqual([holder]);
    });
  });

  it('finds a style-snapshot genre tag typed as the card shows it', async () => {
    const owner = await createUser(testDb.db);
    const session = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Second Wind',
      styleSnapshot: { genreTags: ['lofi'] },
    });

    const { items } = await searchSessions(testDb.db, baseArgs(owner, 'lo-fi'));

    expect(items.map((s) => s.id)).toEqual([session]);
    expect(items[0]!.match).toMatchObject({ field: 'tags', snippet: 'lofi' });
  });

  it('leaves every other Session field matching only as stored', async () => {
    const owner = await createUser(testDb.db);
    const session = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'deep-house',
      userPrompt: 'deep-house',
      styleSnapshot: { mood: 'deep-house', activity: 'deep-house', stylePrompt: 'deep-house' },
    });
    await seedSessionTrack(testDb.db, owner, session, { title: 'deep-house' });

    const { matchCount } = await searchSessions(testDb.db, baseArgs(owner, 'deep house'));

    expect(matchCount).toBe(0);
  });

  it('leaves out a session whose delete is pending', async () => {
    const owner = await createUser(testDb.db);
    const pending = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Rain',
    });
    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, pending));

    const { items, matchCount } = await searchSessions(testDb.db, baseArgs(owner, 'rain'));
    expect(matchCount).toBe(0);
    expect(items).toHaveLength(0);
  });

  it('caps sessions in rank order while matchCount stays exact', async () => {
    const owner = await createUser(testDb.db);
    const whole = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Rain',
    });
    const starts = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Rainstorm',
    });
    await createSession(testDb.db, { ownerUserId: owner, status: 'stopped', title: 'Grainy' });

    const { items, matchCount } = await searchSessions(testDb.db, {
      ...baseArgs(owner, 'rain'),
      limit: 2,
    });
    expect(matchCount).toBe(3);
    expect(items.map((s) => s.id)).toEqual([whole, starts]);
  });

  it('is owner-scoped', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const mine = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Border Case',
    });
    await createSession(testDb.db, {
      ownerUserId: other,
      status: 'stopped',
      title: 'Border Case',
    });

    const { items } = await searchSessions(testDb.db, baseArgs(owner, 'border'));
    expect(items.map((s) => s.id)).toEqual([mine]);
  });
});

describe.skipIf(skip)('searchPlaylists', () => {
  it('matches names and member titles and counts matching members', async () => {
    const owner = await createUser(testDb.db);
    const byName = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Rain Day' });
    const byMembers = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Race Day' });
    const rainA = await seedTrack(owner, { title: 'Rain on Tin' });
    const rainB = await seedTrack(owner, { title: 'Rainfall' });
    const dry = await seedTrack(owner, { title: 'Dry Spell' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: byMembers.id,
      trackIds: [rainA, rainB, dry],
    });

    const { items, matchCount } = await searchPlaylists(testDb.db, baseArgs(owner, 'rain'));
    expect(matchCount).toBe(2);
    const byId = new Map(items.map((p) => [p.id, p]));
    expect(byId.get(byName.id)?.match.field).toBe('name');
    expect(byId.get(byName.id)?.memberMatchCount).toBe(0);
    expect(byId.get(byMembers.id)?.match.field).toBe('tracks');
    expect(byId.get(byMembers.id)?.memberMatchCount).toBe(2);
    expect(byId.get(byMembers.id)?.trackCount).toBe(3);
  });

  it('finds a member genre tag typed as the card shows it, but not a name or title', async () => {
    const owner = await createUser(testDb.db);
    const tagged = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Tagged' });
    const member = await seedTrack(owner, { title: 'Carrier', genreTags: ['drum-and-bass'] });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: tagged.id,
      trackIds: [member],
    });
    const titled = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'drum-and-bass' });
    const titledMember = await seedTrack(owner, { title: 'drum-and-bass' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: titled.id,
      trackIds: [titledMember],
    });

    const { items } = await searchPlaylists(testDb.db, baseArgs(owner, 'drum & bass'));

    expect(items.map((p) => p.id)).toEqual([tagged.id]);
    expect(items[0]).toMatchObject({
      memberMatchCount: 0,
      match: { field: 'tags', snippet: 'drum-and-bass' },
    });
  });

  it('does not pin Favorites above better-ranked matches', async () => {
    const owner = await createUser(testDb.db);
    const favorites = await ensureFavoritesPlaylist(testDb.db, { ownerUserId: owner });
    const rainy = await seedTrack(owner, { title: 'Rainy Value' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: favorites.id,
      trackIds: [rainy],
    });
    const named = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Rain' });

    const { items } = await searchPlaylists(testDb.db, baseArgs(owner, 'rain'));
    expect(items.map((p) => p.id)).toEqual([named.id, favorites.id]);
  });

  it('caps playlists while matchCount stays exact and survivors keep their summaries', async () => {
    const owner = await createUser(testDb.db);
    const whole = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Rain' });
    const starts = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Rainstorm' });
    await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Grainy' });
    const member = await seedTrack(owner, { title: 'Rain on Tin' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: whole.id,
      trackIds: [member],
    });

    const { items, matchCount } = await searchPlaylists(testDb.db, {
      ...baseArgs(owner, 'rain'),
      limit: 2,
    });
    expect(matchCount).toBe(3);
    expect(items.map((p) => p.id)).toEqual([whole.id, starts.id]);
    expect(items[0]!.trackCount).toBe(1);
    expect(items[0]!.memberMatchCount).toBe(1);
    expect(items[1]!.trackCount).toBe(0);
  });

  it('sorts by title A–Z when asked', async () => {
    const owner = await createUser(testDb.db);
    const beta = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Beta Rain' });
    const alpha = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Alpha Rain' });

    const { items } = await searchPlaylists(testDb.db, {
      ...baseArgs(owner, 'rain'),
      sort: 'title',
    });
    expect(items.map((p) => p.id)).toEqual([alpha.id, beta.id]);
  });

  it('is owner-scoped', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const mine = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Fence Line' });
    await createPlaylist(testDb.db, { ownerUserId: other, name: 'Fence Line' });

    const { items } = await searchPlaylists(testDb.db, baseArgs(owner, 'fence'));
    expect(items.map((p) => p.id)).toEqual([mine.id]);
  });
});

// Visitor /search integration: a Lounge-pinned playlist matches in
// the visitor's own Search like their own playlists, attributed, while foreign
// tracks never surface as standalone Track results.
describe.skipIf(skip)('visitor search integration', () => {
  /** An owner's non-empty In-Lounge playlist, pinned by the visitor. */
  async function seedPinnedPlaylist(args: {
    name: string;
    trackTitle: string;
    genreTags?: string[];
    lyrics?: string;
  }) {
    const owner = await createUser(testDb.db);
    const visitor = await createUser(testDb.db);
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: args.name });
    const trackId = await seedTrack(owner, {
      title: args.trackTitle,
      genreTags: args.genreTags ?? [],
      lyrics: args.lyrics ?? null,
    });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      trackIds: [trackId],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      audience: { kind: 'everyone' },
    });
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: visitor,
      playlistId: playlist.id,
      pinned: true,
    });
    return { owner, visitor, playlistId: playlist.id, trackId };
  }

  it('a pinned playlist matches by name in the Playlists group, attributed', async () => {
    const { visitor, playlistId } = await seedPinnedPlaylist({
      name: 'Copper Nights',
      trackTitle: 'Velvet Dusk',
    });

    const { items, matchCount } = await searchPlaylists(testDb.db, baseArgs(visitor, 'copper'));
    expect(matchCount).toBe(1);
    expect(items[0]!.id).toBe(playlistId);
    expect(items[0]!.match.field).toBe('name');
    // The row is visibly foreign: the sharing owner's attribution rides it.
    expect(items[0]!.owner?.name).toBe('Test Admin');
    // What a delete would cost reads the owner's own Library: never the visitor's to see.
    expect(items[0]).toMatchObject({ soleMemberTrackCount: 0, soleMemberDeletedTrackCount: 0 });
  });

  it('a pinned playlist matches by member title and genre tag, like an own playlist', async () => {
    const { visitor, playlistId } = await seedPinnedPlaylist({
      name: 'Foreign Shelf',
      trackTitle: 'Velvet Dusk',
      genreTags: ['glasswave'],
    });
    // The parity control: the visitor's own playlist with an own tagged member
    // must answer the same tag query — a Pin matches exactly like it, no more.
    const own = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'My Shelf' });
    const ownTrack = await seedTrack(visitor, { title: 'Own Carrier', genreTags: ['glasswave'] });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: visitor,
      playlistId: own.id,
      trackIds: [ownTrack],
    });

    const byTitle = await searchPlaylists(testDb.db, baseArgs(visitor, 'velvet'));
    expect(byTitle.items.map((p) => p.id)).toEqual([playlistId]);
    expect(byTitle.items[0]!.match.field).toBe('tracks');
    expect(byTitle.items[0]!.memberMatchCount).toBe(1);

    const byTag = await searchPlaylists(testDb.db, baseArgs(visitor, 'glasswave'));
    expect(new Set(byTag.items.map((p) => p.id))).toEqual(new Set([playlistId, own.id]));
    const rows = new Map(byTag.items.map((p) => [p.id, p]));
    expect(rows.get(playlistId)?.match.field).toBe('tags');
    expect(rows.get(own.id)?.match.field).toBe('tags');
    // Own rows carry no attribution — foreignness is what `owner` marks.
    expect(rows.get(own.id)?.owner).toBeFalsy();
    expect(rows.get(own.id)?.soleMemberTrackCount).toBe(1);
  });

  it('a Shared reference counts toward its containing own playlist track-title match', async () => {
    const owner = await createUser(testDb.db);
    const visitor = await createUser(testDb.db);
    const shared = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Owner Shelf' });
    const foreignTrack = await seedTrack(owner, { title: 'Solitary Beacon' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: shared.id,
      trackIds: [foreignTrack],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId: shared.id,
      audience: { kind: 'everyone' },
    });
    const keepers = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Keepers' });
    // The Shared-reference save: the audible foreign track filed into the
    // visitor's own playlist (the picker commit).
    const applied = await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId: foreignTrack,
      playlistIds: [keepers.id],
    });
    expect(applied).not.toBeNull();

    // Only the visitor's own playlist answers: the owner's shared playlist is
    // not pinned, so it never rides the visitor's /search.
    const { items } = await searchPlaylists(testDb.db, baseArgs(visitor, 'solitary'));
    expect(items.map((p) => p.id)).toEqual([keepers.id]);
    expect(items[0]!.match.field).toBe('tracks');
    expect(items[0]!.memberMatchCount).toBe(1);
  });

  it('a foreign track is never a standalone Track result, lyrics mode included', async () => {
    // Maximum exposure: audible, pinned, AND saved as a reference — the track
    // still only ever helps a Playlist row match.
    const { visitor, trackId } = await seedPinnedPlaylist({
      name: 'Foreign Shelf',
      trackTitle: 'Solitary Beacon',
      lyrics: 'midnight lanterns glow',
    });
    const keepers = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Keepers' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [keepers.id],
    });

    const byTitle = await searchTracks(testDb.db, baseArgs(visitor, 'solitary'));
    expect(byTitle.matchCount).toBe(0);
    expect(byTitle.items).toEqual([]);

    const byLyrics = await searchTracks(testDb.db, {
      ...baseArgs(visitor, 'lanterns'),
      lyricsOnly: true,
    });
    expect(byLyrics.matchCount).toBe(0);
    expect(byLyrics.items).toEqual([]);

    const byMisspelledLyrics = await searchTracks(testDb.db, {
      ...baseArgs(visitor, 'midnite lantrens'),
      lyricsOnly: true,
    });
    expect(byMisspelledLyrics).toEqual({ items: [], matchCount: 0, closeMatches: false });
  });

  it('a pinned re-share never surfaces a reference hidden from the visitor', async () => {
    // X shares T with V alone; V re-shares a playlist holding V's own track
    // plus a reference to T with everyone; W pins it. W sits outside X's
    // audience, so T must not reach W through the Pin.
    const x = await createUser(testDb.db);
    const v = await createUser(testDb.db);
    const w = await createUser(testDb.db);
    const forV = await createPlaylist(testDb.db, { ownerUserId: x, name: 'For V' });
    const hidden = await seedTrack(x, { title: 'Secret Song', genreTags: ['hushcore'] });
    const hiddenCover = await createCoverImage(testDb.db);
    await testDb.pool.query('update tracks set cover_image_id = $1 where id = $2', [
      hiddenCover,
      hidden,
    ]);
    await addPlaylistTracks(testDb.db, { ownerUserId: x, playlistId: forV.id, trackIds: [hidden] });
    await setPlaylistShared(testDb.db, {
      ownerUserId: x,
      playlistId: forV.id,
      audience: { kind: 'selected', userIds: [v] },
    });

    const mixtape = await createPlaylist(testDb.db, { ownerUserId: v, name: 'Mixtape' });
    const own = await seedTrack(v, { title: 'Open Song' });
    await addPlaylistTracks(testDb.db, { ownerUserId: v, playlistId: mixtape.id, trackIds: [own] });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: v,
      trackId: hidden,
      playlistIds: [mixtape.id],
    });
    await setPlaylistShared(testDb.db, {
      ownerUserId: v,
      playlistId: mixtape.id,
      audience: { kind: 'everyone' },
    });
    await setPlaylistLoungePinned(testDb.db, {
      viewerUserId: w,
      playlistId: mixtape.id,
      pinned: true,
    });

    expect((await searchPlaylists(testDb.db, baseArgs(w, 'secret'))).matchCount).toBe(0);
    expect((await searchPlaylists(testDb.db, baseArgs(w, 'hushcore'))).matchCount).toBe(0);
    expect((await searchPlaylists(testDb.db, baseArgs(w, 'hush core'))).matchCount).toBe(0);
    expect((await searchPlaylists(testDb.db, baseArgs(v, 'hush core'))).matchCount).toBe(1);
    const bySong = await searchPlaylists(testDb.db, baseArgs(w, 'song'));
    expect(bySong.items.map((p) => p.id)).toEqual([mixtape.id]);
    expect(bySong.items[0]).toMatchObject({
      memberMatchCount: 1,
      trackCount: 1,
      mosaicCoverImageIds: [],
      match: { field: 'tracks', snippet: 'Open Song' },
    });

    // The owner's own Library still counts the reference.
    const ownerView = await searchPlaylists(testDb.db, baseArgs(v, 'song'));
    expect(ownerView.items[0]).toMatchObject({ memberMatchCount: 2, trackCount: 2 });
  });

  it('unshare stops the pin and the reference from matching, immediately', async () => {
    const { owner, visitor, playlistId, trackId } = await seedPinnedPlaylist({
      name: 'Copper Nights',
      trackTitle: 'Solitary Beacon',
    });
    const keepers = await createPlaylist(testDb.db, { ownerUserId: visitor, name: 'Keepers' });
    await applyTrackMemberships(testDb.db, {
      ownerUserId: visitor,
      trackId,
      playlistIds: [keepers.id],
    });

    await setPlaylistShared(testDb.db, { ownerUserId: owner, playlistId, audience: null });

    // The pin is hard-purged with the share: no Playlists-group hit survives.
    const byName = await searchPlaylists(testDb.db, baseArgs(visitor, 'copper'));
    expect(byName.matchCount).toBe(0);
    // The reference is purged too, so the visitor's own playlist stops
    // matching by the foreign title in the same instant.
    const byMember = await searchPlaylists(testDb.db, baseArgs(visitor, 'solitary'));
    expect(byMember.matchCount).toBe(0);

    // Re-share does not resurrect anything: hard removal means re-pin.
    await setPlaylistShared(testDb.db, {
      ownerUserId: owner,
      playlistId,
      audience: { kind: 'everyone' },
    });
    const afterReshare = await searchPlaylists(testDb.db, baseArgs(visitor, 'copper'));
    expect(afterReshare.matchCount).toBe(0);
  });
});
