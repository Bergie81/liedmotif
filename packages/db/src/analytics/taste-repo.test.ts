import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ListeningOrigin } from '@liedmotif/shared';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { activitySessions, feedbackEvents, generationRequests, tracks } from '../schema';
import { createUser, GENERATION_FIXTURE_TABLES, seedReadyTrack } from '../generation/test-fixtures';
import { deleteTrack } from '../generation/delete-track-repo';
import { rejectDislikedTrack } from '../generation/feedback-repo';
import { deleteSession } from '../generation/session-delete-repo';
import {
  addPlaylistTracks,
  applyTrackMemberships,
  createPlaylist,
  deletePlaylist,
  removePlaylistTrack,
  setTrackFavorited,
  unsaveTrackEverywhere,
} from '../playlists/playlists-repo';
import { setPlaylistShared } from '../playlists/playlist-share-repo';
import { clearListeningHistory } from './history-repo';
import { getListeningStats, recordListening } from './listening-repo';
import {
  getCachedLearnedTaste,
  getLearnedTaste,
  getPersonalization,
  rankForYouGenres,
  resetLearnedTaste,
  setPersonalizeSuggestions,
} from './taste-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const TABLES = [
  'taste_evidence',
  'listening_occurrences',
  'listening_preferences',
  'user_settings',
  'playlists',
  ...GENERATION_FIXTURE_TABLES,
];

const T0 = '2026-09-10T12:00:00Z';
const DAY_MS = 24 * 60 * 60_000;
const at = (base: string, plusMs: number) => new Date(new Date(base).getTime() + plusMs);

describeIfDb('learned taste', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-taste-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, TABLES);
    sessions.clear();
  });

  let nextOccurrence = 0;
  const occurrence = () => `00000000-0000-4000-9000-${String(nextOccurrence++).padStart(12, '0')}`;

  const sessions = new Map<string, string>();

  async function seed(
    ownerUserId: string,
    facts: {
      genre: string;
      energy?: string;
      vocalMode?: 'instrumental' | 'vocal';
      bpm?: number;
      language?: string;
    },
  ) {
    // An owner holds one active Session, so their Tracks share it.
    const sessionId = sessions.get(ownerUserId);
    const seeded = await seedReadyTrack(ctx.db, {
      ownerUserId,
      ...(sessionId ? { sessionId } : {}),
    });
    sessions.set(ownerUserId, seeded.sessionId);
    await ctx.db
      .update(tracks)
      .set({
        durationSeconds: 180,
        genreTags: [facts.genre],
        energy: facts.energy ?? null,
        vocalMode: facts.vocalMode ?? 'instrumental',
        bpmEstimate: facts.bpm ?? null,
        title: 'Night Drive',
      })
      .where(eq(tracks.id, seeded.trackId));
    if (facts.language) {
      await ctx.db
        .update(generationRequests)
        .set({ styleSnapshot: { language: facts.language } })
        .where(eq(generationRequests.id, seeded.requestId));
    }
    return seeded;
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  /** One closed occurrence of `playedMs`, ending at `when`. */
  function listen(
    seeded: Seeded,
    when: Date,
    options: { origin?: ListeningOrigin; playedMs?: number; endReason?: string } = {},
  ) {
    const playedMs = options.playedMs ?? 40_000;
    return recordListening(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      occurrenceId: occurrence(),
      trackId: seeded.trackId,
      sessionId: seeded.sessionId,
      surface: 'session',
      startedAt: new Date(when.getTime() - playedMs),
      listenedMs: playedMs,
      playedMs,
      origin: options.origin ?? 'auto',
      clientTimestamp: when,
      endReason: options.endReason ?? 'ended',
      now: when,
    });
  }

  const taste = (ownerUserId: string, now: Date) =>
    getLearnedTaste(ctx.db, { ownerUserId, now, timezone: 'UTC' });
  const genreScores = async (ownerUserId: string, now: Date) =>
    Object.fromEntries((await taste(ownerUserId, now)).genres.map((g) => [g.value, g.score]));

  it('ranks a Favorite over Playlist membership over a deliberate replay over a passive play', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    // Fixes the seeding moment before any curation exists.
    await taste(owner, now);

    const favorite = await seed(owner, { genre: 'Jazz' });
    const member = await seed(owner, { genre: 'House' });
    const replayed = await seed(owner, { genre: 'Techno' });
    const passive = await seed(owner, { genre: 'Ambient' });
    await setTrackFavorited(ctx.db, {
      ownerUserId: owner,
      trackId: favorite.trackId,
      favorited: true,
    });
    const playlist = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      trackIds: [member.trackId],
    });
    await listen(replayed, now, { origin: 'user' });
    await listen(passive, now);

    const result = await taste(owner, now);
    expect(result.genres.map((g) => g.value)).toEqual(['jazz', 'house', 'techno', 'ambient']);
    expect(result.confident).toBe(true);
  });

  it('credits a Favorite once, not again for the membership favoriting implies', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const starred = await seed(owner, { genre: 'Jazz' });
    const starredAndFiled = await seed(owner, { genre: 'House' });
    const playlist = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });
    for (const s of [starred, starredAndFiled]) {
      await setTrackFavorited(ctx.db, { ownerUserId: owner, trackId: s.trackId, favorited: true });
    }
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: playlist.id,
      trackIds: [starredAndFiled.trackId],
    });

    const scores = await genreScores(owner, now);
    expect(scores.house).toBe(scores.jazz);
  });

  it('drops curation credit when the Track leaves its last Playlist', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const seeded = await seed(owner, { genre: 'Jazz' });
    const playlist = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });
    const membership = { ownerUserId: owner, playlistId: playlist.id };
    await addPlaylistTracks(ctx.db, { ...membership, trackIds: [seeded.trackId] });
    await removePlaylistTrack(ctx.db, { ...membership, trackId: seeded.trackId });

    expect(await genreScores(owner, now)).toEqual({});
  });

  it('halves a play every 90 days while stats keep it whole', async () => {
    const owner = await createUser(ctx.db);
    const seeded = await seed(owner, { genre: 'Techno' });
    await listen(seeded, new Date(T0), { origin: 'user' });

    const fresh = await genreScores(owner, new Date(T0));
    const aged = await genreScores(owner, at(T0, 90 * DAY_MS));
    expect(aged.techno).toBeCloseTo(fresh.techno! / 2, 5);

    const stats = await getListeningStats(ctx.db, {
      ownerUserId: owner,
      range: 'all',
      now: at(T0, 90 * DAY_MS),
      timezone: 'UTC',
    });
    expect(stats.qualifyingPlays).toBe(1);
  });

  it('counts at most three passive plays of a Track per reporting day, and every play in stats', async () => {
    const owner = await createUser(ctx.db);
    const looped = await seed(owner, { genre: 'Techno' });
    const once = await seed(owner, { genre: 'Jazz' });
    for (let i = 0; i < 8; i++) await listen(looped, at(T0, i * 60_000), { origin: 'loop' });
    await listen(once, new Date(T0));

    const firstDay = await genreScores(owner, at(T0, 60 * 60_000));
    expect(firstDay.techno! / firstDay.jazz!).toBeCloseTo(3, 1);

    // The next reporting day opens a fresh allowance.
    await listen(looped, at(T0, DAY_MS));
    const secondDay = await genreScores(owner, at(T0, DAY_MS));
    expect(secondDay.techno! / secondDay.jazz!).toBeCloseTo(4, 1);

    const stats = await getListeningStats(ctx.db, {
      ownerUserId: owner,
      range: 'all',
      now: at(T0, DAY_MS),
      timezone: 'UTC',
    });
    expect(stats.qualifyingPlays).toBe(10);
  });

  it('treats an early skip as doubt about that Track, never as a genre ban', async () => {
    const owner = await createUser(ctx.db);
    const skipped = await seed(owner, { genre: 'Techno' });
    const liked = await seed(owner, { genre: 'Techno' });
    const now = new Date(T0);
    await listen(liked, now);
    const before = (await genreScores(owner, now)).techno;
    for (let i = 0; i < 5; i++) {
      await listen(skipped, at(T0, i * 1000), { playedMs: 8_000, endReason: 'navigated' });
    }

    expect((await genreScores(owner, now)).techno).toBe(before);
  });

  it('lets skips cancel the same Track’s own plays', async () => {
    const owner = await createUser(ctx.db);
    const seeded = await seed(owner, { genre: 'Techno' });
    const now = new Date(T0);
    await listen(seeded, now);
    const before = (await genreScores(owner, now)).techno!;
    await listen(seeded, now, { playedMs: 8_000, endReason: 'navigated' });

    const after = (await genreScores(owner, now)).techno!;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  it('never reads an error, a replaced start, or an unheard cutover as dislike', async () => {
    const owner = await createUser(ctx.db);
    const seeded = await seed(owner, { genre: 'Techno' });
    const now = new Date(T0);
    await listen(seeded, now);
    const before = (await genreScores(owner, now)).techno;
    await listen(seeded, now, { playedMs: 8_000, endReason: 'failed' });
    await listen(seeded, now, { playedMs: 8_000, endReason: 'replaced' });
    await listen(seeded, now, { playedMs: 8_000, endReason: 'stopped' });
    await listen(seeded, now, { playedMs: 500, endReason: 'navigated' });

    expect((await genreScores(owner, now)).techno).toBe(before);
    const events = await ctx.db.select().from(feedbackEvents);
    expect(events).toEqual([]);
  });

  it('discounts a rerolled Track’s own plays and leaves its genre standing', async () => {
    const owner = await createUser(ctx.db);
    const rerolled = await seed(owner, { genre: 'Techno' });
    const kept = await seed(owner, { genre: 'Techno' });
    const now = new Date(T0);
    await listen(rerolled, now);
    await listen(kept, now);
    const before = (await genreScores(owner, now)).techno!;
    await rejectDislikedTrack(ctx.db, { ownerUserId: owner, trackId: rerolled.trackId });

    const after = (await genreScores(owner, now)).techno!;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(before / 2);
  });

  it('seeds once from existing Favorites and Playlist members without inventing listening', async () => {
    const owner = await createUser(ctx.db);
    const favorite = await seed(owner, { genre: 'Jazz' });
    await setPersonalizeSuggestions(ctx.db, { ownerUserId: owner, enabled: false });
    await setTrackFavorited(ctx.db, {
      ownerUserId: owner,
      trackId: favorite.trackId,
      favorited: true,
    });
    // As an account that curated before learned taste existed.
    await ctx.pool.query(
      `update listening_preferences set personalize_suggestions = true, taste_seeded_at = null`,
    );

    expect(Object.keys(await genreScores(owner, new Date(T0)))).toEqual(['jazz']);
    const { rows } = await ctx.pool.query(`select count(*)::int as n from listening_occurrences`);
    expect(rows[0].n).toBe(0);
  });

  it('keeps what a deleted Track taught and holds nothing that names it', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const seeded = await seed(owner, { genre: 'Jazz' });
    await setTrackFavorited(ctx.db, {
      ownerUserId: owner,
      trackId: seeded.trackId,
      favorited: true,
    });
    await listen(seeded, now);
    const before = await genreScores(owner, now);

    await deleteTrack(ctx.db, { ownerUserId: owner, trackId: seeded.trackId });

    expect(await genreScores(owner, now)).toEqual(before);
    const { rows } = await ctx.pool.query(`select * from taste_evidence`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(seeded.trackId);
    expect(JSON.stringify(rows[0])).not.toContain('Night Drive');
  });

  it('resets to a fresh boundary that neither old listening nor current memberships refill', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const seeded = await seed(owner, { genre: 'Jazz' });
    await setTrackFavorited(ctx.db, {
      ownerUserId: owner,
      trackId: seeded.trackId,
      favorited: true,
    });
    await listen(seeded, now);

    await resetLearnedTaste(ctx.db, { ownerUserId: owner, now: at(T0, 1000) });

    expect(await genreScores(owner, at(T0, 2000))).toEqual({});
    const stats = await getListeningStats(ctx.db, {
      ownerUserId: owner,
      range: 'all',
      now: at(T0, 2000),
      timezone: 'UTC',
    });
    expect(stats.qualifyingPlays).toBe(1);

    // New engagement with the old Track teaches again.
    await listen(seeded, at(T0, 60_000));
    expect(Object.keys(await genreScores(owner, at(T0, 60_000)))).toEqual(['jazz']);
  });

  it('refuses a late report of listening begun before the reset', async () => {
    const owner = await createUser(ctx.db);
    const seeded = await seed(owner, { genre: 'Jazz' });
    await resetLearnedTaste(ctx.db, { ownerUserId: owner, now: at(T0, -10_000) });
    await listen(seeded, new Date(T0));

    expect(await genreScores(owner, new Date(T0))).toEqual({});
  });

  it('clears learned taste with listening history, and memberships do not reseed it', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    const seeded = await seed(owner, { genre: 'Jazz' });
    await setTrackFavorited(ctx.db, {
      ownerUserId: owner,
      trackId: seeded.trackId,
      favorited: true,
    });
    await listen(seeded, now);
    // Warm the cache the clearing has to outlive.
    await getCachedLearnedTaste(ctx.db, { ownerUserId: owner, now, timezone: 'UTC' });

    await clearListeningHistory(ctx.db, { ownerUserId: owner, now: at(T0, 1000) });

    const after = await getCachedLearnedTaste(ctx.db, {
      ownerUserId: owner,
      now: at(T0, 2000),
      timezone: 'UTC',
    });
    expect(after.genres).toEqual([]);
  });

  it('learns nothing while personalization is off, and re-enabling does not catch up', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    const before = await seed(owner, { genre: 'Jazz' });
    await listen(before, now);
    await setPersonalizeSuggestions(ctx.db, { ownerUserId: owner, enabled: false });
    expect(await getPersonalization(ctx.db, owner)).toEqual({ enabled: false });

    const during = await seed(owner, { genre: 'Techno' });
    await listen(during, now, { origin: 'user' });
    await setTrackFavorited(ctx.db, {
      ownerUserId: owner,
      trackId: during.trackId,
      favorited: true,
    });
    const off = await taste(owner, now);
    expect(off).toMatchObject({ enabled: false, confident: false, genres: [] });

    await setPersonalizeSuggestions(ctx.db, { ownerUserId: owner, enabled: true });
    expect(Object.keys(await genreScores(owner, now))).toEqual(['jazz']);
    // Stats never depended on the switch.
    const stats = await getListeningStats(ctx.db, {
      ownerUserId: owner,
      range: 'all',
      now,
      timezone: 'UTC',
    });
    expect(stats.qualifyingPlays).toBe(2);
  });

  const personalize = (ownerUserId: string, enabled: boolean) =>
    setPersonalizeSuggestions(ctx.db, { ownerUserId, enabled });
  const favorite = (ownerUserId: string, trackId: string, favorited: boolean) =>
    setTrackFavorited(ctx.db, { ownerUserId, trackId, favorited });

  it('drops a Favorite’s curation credit when it is un-favorited while personalization is off', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const seeded = await seed(owner, { genre: 'Jazz' });
    await favorite(owner, seeded.trackId, true);
    expect(Object.keys(await genreScores(owner, now))).toEqual(['jazz']);

    await personalize(owner, false);
    await favorite(owner, seeded.trackId, false);
    await personalize(owner, true);

    expect(await genreScores(owner, now)).toEqual({});
  });

  it('lowers a Favorite still in another Playlist to a Playlist member when un-favorited while off', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const starred = await seed(owner, { genre: 'Jazz' });
    const picked = await seed(owner, { genre: 'House' });
    const control = await seed(owner, { genre: 'Techno' });
    const drive = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackIds: [starred.trackId, picked.trackId, control.trackId],
    });
    await favorite(owner, starred.trackId, true);
    await favorite(owner, picked.trackId, true);

    await personalize(owner, false);
    await favorite(owner, starred.trackId, false);
    await applyTrackMemberships(ctx.db, {
      ownerUserId: owner,
      trackId: picked.trackId,
      playlistIds: [drive.id],
    });
    await personalize(owner, true);

    const scores = await genreScores(owner, now);
    expect(scores.jazz).toBe(scores.techno);
    expect(scores.house).toBe(scores.techno);
  });

  it('drops curation credit for every way a Track leaves its last Playlist while off', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const removed = await seed(owner, { genre: 'Jazz' });
    const unsaved = await seed(owner, { genre: 'House' });
    const unpicked = await seed(owner, { genre: 'Techno' });
    const disbanded = await seed(owner, { genre: 'Ambient' });
    const drive = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });
    const doomed = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Doomed' });
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackIds: [removed.trackId, unsaved.trackId, unpicked.trackId],
    });
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: doomed.id,
      trackIds: [disbanded.trackId],
    });
    expect(Object.keys(await genreScores(owner, now))).toHaveLength(4);

    await personalize(owner, false);
    await removePlaylistTrack(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackId: removed.trackId,
    });
    await unsaveTrackEverywhere(ctx.db, { ownerUserId: owner, trackId: unsaved.trackId });
    await applyTrackMemberships(ctx.db, {
      ownerUserId: owner,
      trackId: unpicked.trackId,
      playlistIds: [],
    });
    await deletePlaylist(ctx.db, { ownerUserId: owner, playlistId: doomed.id });
    await personalize(owner, true);

    expect(await genreScores(owner, now)).toEqual({});
  });

  it('never creates evidence by taking back a Favorite or membership made while off', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const starred = await seed(owner, { genre: 'Jazz' });
    const filed = await seed(owner, { genre: 'House' });
    const drive = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });

    await personalize(owner, false);
    await favorite(owner, starred.trackId, true);
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackIds: [filed.trackId],
    });
    await favorite(owner, starred.trackId, false);
    await removePlaylistTrack(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackId: filed.trackId,
    });
    await personalize(owner, true);

    expect(await genreScores(owner, now)).toEqual({});
    const { rows } = await ctx.pool.query(`select count(*)::int as n from taste_evidence`);
    expect(rows[0].n).toBe(0);
  });

  it('gains nothing while off: no Favorite, Playlist add, upgrade or listening, and no catch-up', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const upgraded = await seed(owner, { genre: 'Jazz' });
    const control = await seed(owner, { genre: 'Pop' });
    const drive = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackIds: [upgraded.trackId, control.trackId],
    });

    await personalize(owner, false);
    const starred = await seed(owner, { genre: 'House' });
    const filed = await seed(owner, { genre: 'Techno' });
    const heard = await seed(owner, { genre: 'Ambient' });
    await favorite(owner, upgraded.trackId, true);
    await favorite(owner, starred.trackId, true);
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackIds: [filed.trackId],
    });
    await listen(heard, now, { origin: 'user' });
    await personalize(owner, true);

    const scores = await genreScores(owner, now);
    expect(Object.keys(scores).sort()).toEqual(['jazz', 'pop']);
    expect(scores.jazz).toBe(scores.pop);
  });

  it('drops a disliked Track’s curation credit while off, without discounting its plays', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const starred = await seed(owner, { genre: 'Jazz' });
    const filed = await seed(owner, { genre: 'House' });
    const uncurated = await seed(owner, { genre: 'Ambient' });
    const control = await seed(owner, { genre: 'Techno' });
    for (const s of [starred, filed, uncurated, control]) await listen(s, now);
    await favorite(owner, starred.trackId, true);
    const drive = await createPlaylist(ctx.db, { ownerUserId: owner, name: 'Drive' });
    await addPlaylistTracks(ctx.db, {
      ownerUserId: owner,
      playlistId: drive.id,
      trackIds: [filed.trackId],
    });

    await personalize(owner, false);
    for (const s of [starred, filed, uncurated]) {
      await rejectDislikedTrack(ctx.db, { ownerUserId: owner, trackId: s.trackId });
    }
    const { rows } = await ctx.pool.query(`select count(*)::int as n from taste_evidence`);
    expect(rows[0].n).toBe(0);
    await personalize(owner, true);

    const scores = await genreScores(owner, now);
    expect(scores.jazz).toBe(scores.techno);
    expect(scores.house).toBe(scores.techno);
    expect(scores.ambient).toBe(scores.techno);
  });

  it('uses no learned taste while off, also after a withdrawal', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    for (const genre of ['Jazz', 'House', 'Techno']) {
      const s = await seed(owner, { genre });
      await favorite(owner, s.trackId, true);
      await listen(s, now, { origin: 'user' });
    }
    const withdrawn = await seed(owner, { genre: 'Ambient' });
    await favorite(owner, withdrawn.trackId, true);
    expect((await taste(owner, now)).confident).toBe(true);

    await personalize(owner, false);
    await favorite(owner, withdrawn.trackId, false);

    expect(await taste(owner, now)).toMatchObject({ enabled: false, confident: false, genres: [] });
  });

  it('keeps listening learned before the switch when a withdrawal runs while off', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const withdrawn = await seed(owner, { genre: 'Jazz' });
    const control = await seed(owner, { genre: 'Techno' });
    await listen(withdrawn, now);
    await listen(control, now);
    await favorite(owner, withdrawn.trackId, true);

    await personalize(owner, false);
    await favorite(owner, withdrawn.trackId, false);
    await personalize(owner, true);

    const scores = await genreScores(owner, now);
    expect(scores.techno).toBeGreaterThan(0);
    expect(scores.jazz).toBe(scores.techno);
  });

  it('keeps what deleted music taught when Track and Session are deleted while off', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    await taste(owner, now);
    const starred = await seed(owner, { genre: 'Jazz' });
    const heard = await seed(owner, { genre: 'Techno' });
    await favorite(owner, starred.trackId, true);
    await listen(starred, now);
    await listen(heard, now);
    const before = await genreScores(owner, now);
    expect(Object.keys(before).sort()).toEqual(['jazz', 'techno']);

    await personalize(owner, false);
    await deleteTrack(ctx.db, { ownerUserId: owner, trackId: starred.trackId });
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped' })
      .where(eq(activitySessions.id, heard.sessionId));
    expect(
      await deleteSession(ctx.db, { ownerUserId: owner, sessionId: heard.sessionId }),
    ).toMatchObject({ ok: true });
    await personalize(owner, true);

    expect(await genreScores(owner, now)).toEqual(before);
  });

  it('reads only the owner’s own evidence', async () => {
    const owner = await createUser(ctx.db);
    const other = await createUser(ctx.db);
    const theirs = await seed(other, { genre: 'Metal' });
    await listen(theirs, new Date(T0));
    await setTrackFavorited(ctx.db, {
      ownerUserId: other,
      trackId: theirs.trackId,
      favorited: true,
    });

    expect(await genreScores(owner, new Date(T0))).toEqual({});
  });

  it('ignores a Shared reference, even starred and filed in the owner’s own Playlist', async () => {
    const sharer = await createUser(ctx.db);
    const visitor = await createUser(ctx.db);
    const theirs = await seed(sharer, { genre: 'Metal' });
    const shelf = await createPlaylist(ctx.db, { ownerUserId: sharer, name: 'Shared shelf' });
    await addPlaylistTracks(ctx.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      trackIds: [theirs.trackId],
    });
    await setPlaylistShared(ctx.db, {
      ownerUserId: sharer,
      playlistId: shelf.id,
      audience: { kind: 'everyone' },
    });
    await taste(visitor, new Date(T0));

    const starred = await setTrackFavorited(ctx.db, {
      ownerUserId: visitor,
      trackId: theirs.trackId,
      favorited: true,
    });
    expect(starred).toMatchObject({ trackId: theirs.trackId });
    const foreignListen = await listen({ ...theirs, ownerUserId: visitor }, new Date(T0));
    expect(foreignListen.ok).toBe(false);

    expect(await genreScores(visitor, new Date(T0))).toEqual({});
  });

  it('never serves an answer cached before a reset, however late its write lands', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    const seeded = await seed(owner, { genre: 'Jazz' });
    await listen(seeded, now);
    // The first read stamps the seeding, so the second is the one cached.
    await getCachedLearnedTaste(ctx.db, { ownerUserId: owner, now, timezone: 'UTC' });
    await getCachedLearnedTaste(ctx.db, { ownerUserId: owner, now, timezone: 'UTC' });
    const stale = await ctx.pool.query(
      `select value from user_settings where owner_user_id = $1 and key = 'learnedTaste'`,
      [owner],
    );

    await resetLearnedTaste(ctx.db, { ownerUserId: owner, now: at(T0, 1000) });
    await ctx.pool.query(
      `insert into user_settings (owner_user_id, key, value) values ($1, 'learnedTaste', $2)`,
      [owner, JSON.stringify(stale.rows[0].value)],
    );

    const after = await getCachedLearnedTaste(ctx.db, {
      ownerUserId: owner,
      now: at(T0, 2000),
      timezone: 'UTC',
    });
    expect(after.genres).toEqual([]);
  });

  it('never caches an answer measured while Personalize turned off', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    const seeded = await seed(owner, { genre: 'Jazz' });
    await listen(seeded, now);
    await getCachedLearnedTaste(ctx.db, { ownerUserId: owner, now, timezone: 'UTC' });

    // The switch flips in another tab after the taste aggregate (the read that
    // answers facet rows) and before the answer is cached.
    let flipped = false;
    const racing = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop !== 'execute') return Reflect.get(target, prop, receiver);
        return async (...args: Parameters<typeof target.execute>) => {
          const result = await target.execute(...args);
          if (!flipped && result.rows.some((row) => 'facet' in row)) {
            flipped = true;
            await setPersonalizeSuggestions(ctx.db, { ownerUserId: owner, enabled: false });
          }
          return result;
        };
      },
    });
    await getCachedLearnedTaste(racing, {
      ownerUserId: owner,
      now: at(T0, 20 * 60_000),
      timezone: 'UTC',
    });
    expect(flipped).toBe(true);

    const after = await getCachedLearnedTaste(ctx.db, {
      ownerUserId: owner,
      now: at(T0, 21 * 60_000),
      timezone: 'UTC',
    });
    expect(after).toMatchObject({ enabled: false, genres: [] });
  });

  it('summarizes energy, tempo, vocal preference and language', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    const sung = await seed(owner, {
      genre: 'Pop',
      energy: 'high',
      vocalMode: 'vocal',
      bpm: 120,
      language: 'German',
    });
    const quiet = await seed(owner, { genre: 'Ambient', energy: 'low', bpm: 60 });
    await listen(sung, now, { origin: 'user' });
    await listen(sung, at(T0, 1000), { origin: 'user' });
    await listen(sung, at(T0, 2000), { origin: 'user' });
    await listen(quiet, now, { origin: 'user' });

    const result = await taste(owner, at(T0, 2000));
    expect(result.energies.map((e) => e.value)).toEqual(['high', 'low']);
    expect(result.vocalModes.map((v) => v.value)).toEqual(['vocal', 'instrumental']);
    expect(result.languages.map((l) => l.value)).toEqual(['german']);
    expect(result.tempoBpm).toBeCloseTo(105, 0);
  });

  it('offers For you genres from the vocabulary only when confident', async () => {
    const owner = await createUser(ctx.db);
    const now = new Date(T0);
    const first = await seed(owner, { genre: 'Weimar Cabaret' });
    await listen(first, now, { origin: 'user' });
    const sparse = await taste(owner, now);
    expect(sparse.confident).toBe(false);
    expect(rankForYouGenres(sparse, { vocabulary: ['jazz', 'techno'], limit: 16 })).toEqual([]);

    for (const genre of ['Jazz', 'Techno', 'Jazz']) {
      await listen(await seed(owner, { genre }), now, { origin: 'user' });
    }
    const learned = await taste(owner, now);
    expect(learned.confident).toBe(true);
    expect(rankForYouGenres(learned, { vocabulary: ['jazz', 'techno'], limit: 16 })).toEqual([
      'jazz',
      'techno',
    ]);
    expect(rankForYouGenres(learned, { vocabulary: ['jazz', 'techno'], limit: 1 })).toEqual([
      'jazz',
    ]);
  });
});
