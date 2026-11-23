import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { addPlaylistTracks, createPlaylist, setSessionPinned } from '@liedmotif/db';
import { searchResponseSchema } from '@liedmotif/shared';

// GET /api/search: the house envelope over ranked, capped groups
// with exact counts; validation errors for malformed params; owner-scoped;
// lyrics mode returns a tracks group only; audio stays app-routed.

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET: searchGet } = await import('@/app/api/search/route');

const TABLES = ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES] as const;
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function getWith(params: Record<string, string>) {
  const url = new URL('http://localhost/api/search');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return searchGet(new Request(url));
}

async function seedTrack(
  ownerUserId: string,
  seed: {
    title?: string | null;
    prompt?: string;
    lyrics?: string | null;
    audioStorageKey?: string;
    sessionTitle?: string;
  } = {},
): Promise<string> {
  const sessionId = await createSession(testDb.db, {
    ownerUserId,
    status: 'stopped',
    title: seed.sessionTitle ?? 'Quiet Corner',
  });
  const requestId = await createGenerationRequest(testDb.db, {
    ownerUserId,
    activitySessionId: sessionId,
  });
  const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
  return createTrack(testDb.db, {
    ownerUserId,
    generationRequestId: requestId,
    providerJobId,
    prompt: seed.prompt ?? 'untouched seed material',
    title: seed.title ?? null,
    lyrics: seed.lyrics ?? null,
    ...(seed.audioStorageKey ? { audioStorageKey: seed.audioStorageKey } : {}),
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('search-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('GET /api/search', () => {
  it('returns the three ranked groups with exact counts for a multi-kind query', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'active',
      title: 'Rainy Morning',
    });
    const trackId = await seedTrack(owner, {
      title: 'Rain on Tin',
      audioStorageKey: 'search-route/rain.mp3',
    });
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Race Day' });
    await addPlaylistTracks(testDb.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      trackIds: [trackId],
    });

    const body = await (await getWith({ q: 'rain' })).json();
    expect(body.ok).toBe(true);
    expect(body.data.scope).toBe('all');
    expect(body.data.lyrics).toBe(false);
    // The Track's own Session answers too, through its Track title, ranked below the Name hit.
    expect(body.data.sessions.matchCount).toBe(2);
    expect(body.data.sessions.items[0].title).toBe('Rainy Morning');
    expect(body.data.sessions.items[0].status).toBe('active');
    expect(body.data.sessions.items[0].matchContext.field).toBe('name');
    expect(body.data.tracks.matchCount).toBe(1);
    expect(body.data.tracks.items[0].id).toBe(trackId);
    expect(body.data.tracks.items[0].matchContext).toEqual({
      field: 'name',
      snippet: 'Rain on Tin',
    });
    expect(body.data.playlists.matchCount).toBe(1);
    expect(body.data.playlists.items[0].matchContext.field).toBe('tracks');
    expect(body.data.playlists.items[0].memberMatchCount).toBe(1);
  });

  it('answers Session hits in the contract shape, carrying their pinned state', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const pinned = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Rain Pinned',
    });
    await createSession(testDb.db, { ownerUserId: owner, status: 'stopped', title: 'Rain Loose' });
    await setSessionPinned(testDb.db, { ownerUserId: owner, sessionId: pinned, pinned: true });

    const body = await (await getWith({ q: 'rain', scope: 'sessions' })).json();

    expect(searchResponseSchema.safeParse(body).success).toBe(true);
    const flags = Object.fromEntries(
      body.data.sessions.items.map((s: { title: string; pinned: boolean }) => [s.title, s.pinned]),
    );
    expect(flags).toEqual({ 'Rain Pinned': true, 'Rain Loose': false });
  });

  it('rejects a one-character query, an unknown scope or sort, and a malformed lyrics flag', async () => {
    holder.ownerUserId = await createUser(testDb.db);
    const malformed: Record<string, string>[] = [
      { q: 'x' },
      { q: 'rain', scope: 'albums' },
      { q: 'rain', sort: 'oldest' },
      { q: 'rain', lyrics: 'maybe' },
    ];
    for (const params of malformed) {
      const response = await getWith(params);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('validation_error');
    }
  });

  it('caps the All scope at 5 per group while a scope tab returns up to 50', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    for (let i = 0; i < 7; i += 1) await seedTrack(owner, { title: `Cap Study ${i}` });

    const all = await (await getWith({ q: 'cap study' })).json();
    expect(all.data.tracks.items).toHaveLength(5);
    expect(all.data.tracks.matchCount).toBe(7);
    expect(all.data.tracks.truncated).toBe(true);

    const scoped = await (await getWith({ q: 'cap study', scope: 'tracks' })).json();
    expect(scoped.data.tracks.items).toHaveLength(7);
    expect(scoped.data.tracks.truncated).toBe(false);
    expect(scoped.data.sessions).toBeNull();
    expect(scoped.data.playlists).toBeNull();
  });

  it('lyrics mode returns a tracks group only, matched on lyric text alone', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const sung = await seedTrack(owner, {
      title: 'Sunset Drive',
      lyrics: 'walking in the rain tonight',
    });
    await seedTrack(owner, { title: 'Rain Dance' });
    await createSession(testDb.db, { ownerUserId: owner, status: 'active', title: 'Rain Room' });

    const body = await (await getWith({ q: 'rain', lyrics: '1' })).json();
    expect(body.data.lyrics).toBe(true);
    expect(body.data.sessions).toBeNull();
    expect(body.data.playlists).toBeNull();
    expect(body.data.tracks.items.map((t: { id: string }) => t.id)).toEqual([sung]);
    expect(body.data.tracks.items[0].matchContext.field).toBe('lyrics');
    expect(body.data.closeMatches).toBe(false);
  });

  it('lyrics mode answers a misspelled line with flagged close matches, the same on reload', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const moon = await seedTrack(owner, {
      title: 'Vier im Mondorbit',
      lyrics: 'wir starten heute Nacht\nzu viert auf dem Mond',
    });
    await seedTrack(owner, { title: 'Harbor Lights', lyrics: 'the tide rolls in at dawn' });

    const params = { q: 'zu viert auf dem mnod', lyrics: '1', sort: 'title' };
    const body = await (await getWith(params)).json();
    expect(searchResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data.closeMatches).toBe(true);
    expect(body.data.sessions).toBeNull();
    expect(body.data.playlists).toBeNull();
    expect(body.data.tracks.truncated).toBe(false);
    expect(body.data.tracks.matchCount).toBe(body.data.tracks.items.length);
    expect(body.data.tracks.items[0].id).toBe(moon);
    expect(body.data.tracks.items[0].matchContext).toEqual({
      field: 'lyrics',
      snippet: 'zu viert auf dem Mond',
    });

    const reload = await (await getWith(params)).json();
    expect(reload.data.tracks).toEqual(body.data.tracks);

    // A normal search never answers with lyric lines; its close matches are names.
    const normal = await (await getWith({ q: 'zu viert auf dem mnod' })).json();
    for (const item of normal.data.tracks.items as { matchContext: { field: string } }[]) {
      expect(item.matchContext.field).toBe('name');
    }
  });

  it('lyrics mode uses the scoped cap — Tracks is its only group', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    for (let i = 0; i < 7; i += 1) {
      await seedTrack(owner, { title: `Verse ${i}`, lyrics: `humming in the moonlight ${i}` });
    }

    const body = await (await getWith({ q: 'moonlight', lyrics: '1' })).json();
    expect(body.data.tracks.items).toHaveLength(7);
    expect(body.data.tracks.matchCount).toBe(7);
    expect(body.data.tracks.truncated).toBe(false);
  });

  it('requires the owner session and never returns another owner rows', async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    await seedTrack(other, { title: 'Shared Words' });

    const unauthenticated = await getWith({ q: 'shared' });
    expect(unauthenticated.status).toBe(401);

    holder.ownerUserId = owner;
    const mine = await seedTrack(owner, { title: 'Shared Words' });
    const body = await (await getWith({ q: 'shared words' })).json();
    expect(body.data.tracks.items.map((t: { id: string }) => t.id)).toEqual([mine]);
    expect(body.data.tracks.matchCount).toBe(1);
  });

  it('serves track audio as app-routed paths only', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const playable = await seedTrack(owner, {
      title: 'Audio Check A',
      audioStorageKey: 'search-route/audio-check.mp3',
    });
    await seedTrack(owner, { title: 'Audio Check B' });

    const body = await (await getWith({ q: 'audio check', scope: 'tracks' })).json();
    const byId = new Map(
      body.data.tracks.items.map((t: { id: string; audioUrl: string | null }) => [t.id, t]),
    );
    expect((byId.get(playable) as { audioUrl: string }).audioUrl).toBe(`/api/audio/${playable}`);
    for (const item of body.data.tracks.items as { audioUrl: string | null }[]) {
      if (item.audioUrl !== null) expect(item.audioUrl.startsWith('/api/audio/')).toBe(true);
    }
  });

  it('answers a whole miss under All with the closest names in each group, flagged', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const session = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Rainy Sunday Jazz',
    });
    const track = await seedTrack(owner, { title: 'Sunday Morning Haze' });
    const playlist = await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Jazz for Rain' });

    const body = await (await getWith({ q: 'Rainy Sunday Joz' })).json();

    expect(searchResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data.closeMatches).toBe(true);
    expect(body.data.sessions.items[0]).toMatchObject({
      id: session,
      title: 'Rainy Sunday Jazz',
      matchContext: { field: 'name', snippet: 'Rainy Sunday Jazz' },
    });
    expect(body.data.sessions.items[0].trackCount).toBe(0);
    expect(ids(body.data.tracks.items)).toContain(track);
    expect(ids(body.data.playlists.items)).toContain(playlist.id);
    expect(body.data.playlists.items[0].memberMatchCount).toBe(0);
    for (const group of [body.data.sessions, body.data.tracks, body.data.playlists]) {
      expect(group.matchCount).toBe(group.items.length);
      expect(group.truncated).toBe(false);
    }
  });

  it('keeps exact hits alone when only some groups miss', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const close = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Rainy Sunday Jazz',
    });
    await createPlaylist(testDb.db, { ownerUserId: owner, name: 'Rainy Sunday Jazz' });
    const exact = await seedTrack(owner, { title: 'Rainy Sunday Joz' });

    const body = await (await getWith({ q: 'Rainy Sunday Joz' })).json();

    expect(body.data.closeMatches).toBe(false);
    expect(ids(body.data.tracks.items)).toEqual([exact]);
    // The exact Track's own Session answers through its Track title; the close one stays out.
    expect(ids(body.data.sessions.items)).not.toContain(close);
    expect(body.data.playlists).toEqual({ items: [], matchCount: 0, truncated: false });
  });

  it('answers a scope tab miss with close names of that kind only', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Rainy Sunday Jazz',
    });
    const track = await seedTrack(owner, { title: 'Rainy Sunday Jazz' });

    const body = await (await getWith({ q: 'Rainy Sunday Joz', scope: 'tracks' })).json();

    expect(searchResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data.closeMatches).toBe(true);
    expect(body.data.sessions).toBeNull();
    expect(body.data.playlists).toBeNull();
    expect(ids(body.data.tracks.items)).toEqual([track]);
  });

  it('answers a miss with no shared spelling as an empty, unflagged result', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    await createSession(testDb.db, { ownerUserId: owner, status: 'stopped', title: 'Deep Focus' });

    const body = await (await getWith({ q: 'lighthouse' })).json();

    expect(body.data.closeMatches).toBe(false);
    expect(body.data.sessions.items).toEqual([]);
  });

  it('keeps close names closest first whatever the sort, the same on reload', async () => {
    const owner = await createUser(testDb.db);
    holder.ownerUserId = owner;
    const meant = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Night Owls',
    });
    const other = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Aardvark Night Shift',
    });

    const params = { q: 'Nihgt Owls', scope: 'sessions', sort: 'title' };
    const body = await (await getWith(params)).json();
    expect(ids(body.data.sessions.items)).toEqual([meant, other]);

    const reload = await (await getWith(params)).json();
    expect(reload.data.sessions).toEqual(body.data.sessions);
  });
});

function ids(items: { id: string }[]): string[] {
  return items.map((item) => item.id);
}
