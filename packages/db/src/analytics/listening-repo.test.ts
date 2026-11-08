import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { activitySessions, listeningOccurrences, tracks } from '../schema';
import {
  createCoverImage,
  GENERATION_FIXTURE_TABLES,
  seedReadyTrack,
} from '../generation/test-fixtures';
import { getCachedListeningStats, getListeningStats, recordListening } from './listening-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const TABLES = [
  'listening_occurrences',
  'listening_preferences',
  'user_settings',
  ...GENERATION_FIXTURE_TABLES,
];

describeIfDb('listening reports → owner stats', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-listening-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  /** The Instance's timezone setting, which every read follows. */
  let instanceTimezone = 'UTC';
  beforeEach(async () => {
    await truncateTables(ctx.pool, TABLES);
    instanceTimezone = 'UTC';
  });

  let nextOccurrence = 0;
  const occurrence = () => `00000000-0000-4000-8000-${String(nextOccurrence++).padStart(12, '0')}`;

  async function seed(durationSeconds: number | null = 180) {
    const seeded = await seedReadyTrack(ctx.db);
    await ctx.db.update(tracks).set({ durationSeconds }).where(eq(tracks.id, seeded.trackId));
    return seeded;
  }

  /** A report whose listening ran unbroken up to `at`. */
  function report(
    seeded: { ownerUserId: string; trackId: string; sessionId: string },
    occurrenceId: string,
    at: string,
    listenedMs: number,
    surface: 'session' | 'playlist' | 'preview' = 'session',
    extra: { playedMs?: number; origin?: 'user' | 'auto' | 'loop'; endReason?: string } = {},
  ) {
    const clientTimestamp = new Date(at);
    return recordListening(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      occurrenceId,
      trackId: seeded.trackId,
      sessionId: surface === 'session' ? seeded.sessionId : null,
      surface,
      startedAt: new Date(clientTimestamp.getTime() - (extra.playedMs ?? listenedMs)),
      listenedMs,
      playedMs: extra.playedMs ?? listenedMs,
      origin: extra.origin ?? 'auto',
      clientTimestamp,
      endReason: extra.endReason ?? null,
      now: clientTimestamp,
    });
  }

  function stats(ownerUserId: string, now: string, range: '7d' | '30d' | 'all' = '30d') {
    return getListeningStats(ctx.db, {
      ownerUserId,
      range,
      now: new Date(now),
      timezone: instanceTimezone,
    });
  }

  it('shows reported own-Session listening as time, and as a play only from 30 seconds', async () => {
    const seeded = await seed(180);
    const id = occurrence();

    await report(seeded, id, '2026-09-10T12:00:29.999Z', 29_999);
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 29_999,
      qualifyingPlays: 0,
    });

    await report(seeded, id, '2026-09-10T12:00:30Z', 30_000);
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 30_000,
      qualifyingPlays: 1,
    });
  });

  it('qualifies a Track shorter than a minute at half its duration', async () => {
    const seeded = await seed(40);
    const id = occurrence();
    await report(seeded, id, '2026-09-10T12:00:19Z', 19_000);
    expect((await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).qualifyingPlays).toBe(0);
    await report(seeded, id, '2026-09-10T12:00:20Z', 20_000);
    expect((await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).qualifyingPlays).toBe(1);
  });

  it('reconciles an unknown duration to a short one without a second play', async () => {
    const seeded = await seed(null);
    const id = occurrence();
    await report(seeded, id, '2026-09-10T12:00:25Z', 25_000);
    expect((await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).qualifyingPlays).toBe(0);

    await ctx.db.update(tracks).set({ durationSeconds: 40 }).where(eq(tracks.id, seeded.trackId));
    await report(seeded, id, '2026-09-10T12:00:26Z', 26_000);
    await report(seeded, id, '2026-09-10T12:00:35Z', 35_000);
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 35_000,
      qualifyingPlays: 1,
    });
  });

  it('ignores retried and out-of-order reports within one occurrence', async () => {
    const seeded = await seed();
    const id = occurrence();
    await report(seeded, id, '2026-09-10T12:00:45Z', 45_000);
    await report(seeded, id, '2026-09-10T12:00:45Z', 45_000);
    await report(seeded, id, '2026-09-10T12:00:15Z', 15_000);
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 45_000,
      qualifyingPlays: 1,
    });
  });

  it('counts a replay as its own occurrence', async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:01:00Z', 60_000);
    await report(seeded, occurrence(), '2026-09-10T12:05:00Z', 60_000);
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 120_000,
      qualifyingPlays: 2,
    });
  });

  it('shares crossfade overlap between two Tracks while each still qualifies on what it played', async () => {
    const seeded = await seed();
    // Each played 30 s; 10 s of that overlapped the other and is credited half.
    await report(seeded, occurrence(), '2026-09-10T12:00:30Z', 25_000, 'session', {
      playedMs: 30_000,
    });
    await report(seeded, occurrence(), '2026-09-10T12:00:50Z', 25_000, 'session', {
      playedMs: 30_000,
    });
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 50_000,
      qualifyingPlays: 2,
    });
  });

  it('adds two devices playing the same hour of the same Track to two hours', async () => {
    const seeded = await seed(3600);
    await report(seeded, occurrence(), '2026-09-10T13:00:00Z', 3_600_000);
    await report(seeded, occurrence(), '2026-09-10T13:00:00Z', 3_600_000);
    expect(await stats(seeded.ownerUserId, '2026-09-10T14:00:00Z')).toMatchObject({
      listenedMs: 7_200_000,
      qualifyingPlays: 2,
    });
  });

  it('keeps how an occurrence started and the first way it ended', async () => {
    const seeded = await seed();
    const id = occurrence();
    await report(seeded, id, '2026-09-10T12:00:40Z', 40_000, 'session', { origin: 'loop' });
    await report(seeded, id, '2026-09-10T12:00:45Z', 45_000, 'session', {
      origin: 'loop',
      endReason: 'failed',
    });
    // A duplicate end callback arrives with a different reason and no new time.
    await report(seeded, id, '2026-09-10T12:00:45Z', 45_000, 'session', {
      origin: 'user',
      endReason: 'ended',
    });
    const rows = await ctx.db.select().from(listeningOccurrences);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      startOrigin: 'loop',
      endReason: 'failed',
      listenedMs: 45_000,
      playedMs: 45_000,
    });
  });

  it('adds Playlist and preview listening of an own Track to the same totals as its Session plays', async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:01:00Z', 60_000, 'session');
    await report(seeded, occurrence(), '2026-09-10T12:03:00Z', 45_000, 'playlist');
    await report(seeded, occurrence(), '2026-09-10T12:05:00Z', 20_000, 'preview');
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 125_000,
      qualifyingPlays: 2,
    });
  });

  it('records only the owned Tracks of a mixed Playlist, for listener and Track owner alike', async () => {
    const listener = await seed();
    const other = await seed();
    const own = await report(listener, occurrence(), '2026-09-10T12:01:00Z', 60_000, 'playlist');
    const foreign = await recordListening(ctx.db, {
      ownerUserId: listener.ownerUserId,
      occurrenceId: occurrence(),
      trackId: other.trackId,
      sessionId: null,
      surface: 'playlist',
      startedAt: new Date('2026-09-10T12:01:00Z'),
      origin: 'auto',
      listenedMs: 60_000,
      playedMs: 60_000,
      clientTimestamp: new Date('2026-09-10T12:02:00Z'),
      endReason: null,
      now: new Date('2026-09-10T12:02:00Z'),
    });
    expect(own).toMatchObject({ ok: true });
    expect(foreign).toEqual({ ok: false, reason: 'not_found' });
    expect((await stats(listener.ownerUserId, '2026-09-10T13:00:00Z')).listenedMs).toBe(60_000);
    expect((await stats(other.ownerUserId, '2026-09-10T13:00:00Z')).listenedMs).toBe(0);
  });

  it('leaves the Session, its Queue and generation untouched by Playlist and preview reports', async () => {
    const seeded = await seed();
    const snapshot = async () => ({
      session: (
        await ctx.pool.query('select * from activity_sessions where id = $1', [seeded.sessionId])
      ).rows,
      track: (await ctx.pool.query('select * from tracks where id = $1', [seeded.trackId])).rows,
      queue: (await ctx.pool.query('select * from activity_session_queue_items order by id')).rows,
      requests: (await ctx.pool.query('select count(*) from generation_requests')).rows,
      events: (await ctx.pool.query('select count(*) from playback_events')).rows,
    });
    const before = await snapshot();
    // A client that wrongly names a Session on a non-Session surface links nothing.
    const result = await recordListening(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      occurrenceId: occurrence(),
      trackId: seeded.trackId,
      sessionId: seeded.sessionId,
      surface: 'playlist',
      startedAt: new Date('2026-09-10T12:00:00Z'),
      origin: 'auto',
      listenedMs: 60_000,
      playedMs: 60_000,
      clientTimestamp: new Date('2026-09-10T12:01:00Z'),
      endReason: 'ended',
      now: new Date('2026-09-10T12:01:00Z'),
    });
    await report(seeded, occurrence(), '2026-09-10T12:03:00Z', 60_000, 'preview');
    expect(result).toMatchObject({ ok: true });
    expect(await snapshot()).toEqual(before);
    const linked = await ctx.pool.query(
      'select surface, session_id from listening_occurrences order by surface',
    );
    expect(linked.rows).toEqual([
      { surface: 'playlist', session_id: null },
      { surface: 'preview', session_id: null },
    ]);
  });

  it("refuses another owner's Track and an unknown Track identically, recording nothing", async () => {
    const mine = await seed();
    const theirs = await seed();
    const foreign = await report(
      { ...mine, trackId: theirs.trackId },
      occurrence(),
      '2026-09-10T12:01:00Z',
      60_000,
    );
    const unknown = await report(
      { ...mine, trackId: '11111111-1111-4111-8111-111111111111' },
      occurrence(),
      '2026-09-10T12:01:00Z',
      60_000,
    );
    expect(foreign).toEqual({ ok: false, reason: 'not_found' });
    expect(unknown).toEqual(foreign);
    for (const owner of [mine.ownerUserId, theirs.ownerUserId]) {
      expect(await stats(owner, '2026-09-10T13:00:00Z')).toMatchObject({
        listenedMs: 0,
        qualifyingPlays: 0,
      });
    }
  });

  it("keeps one owner's listening out of another owner's stats", async () => {
    const mine = await seed();
    const theirs = await seed();
    await report(mine, occurrence(), '2026-09-10T12:01:00Z', 60_000);
    expect((await stats(theirs.ownerUserId, '2026-09-10T13:00:00Z')).listenedMs).toBe(0);
  });

  it('refuses listening time that outruns the wall clock or comes from the future', async () => {
    const seeded = await seed();
    const at = new Date('2026-09-10T12:00:00Z');
    const base = {
      ownerUserId: seeded.ownerUserId,
      trackId: seeded.trackId,
      sessionId: seeded.sessionId,
      surface: 'session' as const,
      origin: 'auto' as const,
      endReason: null,
      now: at,
    };
    const inflated = await recordListening(ctx.db, {
      ...base,
      occurrenceId: occurrence(),
      startedAt: new Date(at.getTime() - 60_000),
      listenedMs: 3_600_000,
      playedMs: 3_600_000,
      clientTimestamp: at,
    });
    const overCredited = await recordListening(ctx.db, {
      ...base,
      occurrenceId: occurrence(),
      startedAt: new Date(at.getTime() - 60_000),
      listenedMs: 50_000,
      playedMs: 40_000,
      clientTimestamp: at,
    });
    const future = await recordListening(ctx.db, {
      ...base,
      occurrenceId: occurrence(),
      startedAt: new Date(at.getTime() + 3_600_000),
      listenedMs: 60_000,
      playedMs: 60_000,
      clientTimestamp: new Date(at.getTime() + 3_660_000),
    });
    expect(overCredited).toEqual({ ok: false, reason: 'invalid' });
    expect(inflated).toEqual({ ok: false, reason: 'invalid' });
    expect(future).toEqual({ ok: false, reason: 'invalid' });
    expect((await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).listenedMs).toBe(0);
  });

  it('attributes listening that straddles midnight to each day it fell on', async () => {
    const seeded = await seed(600);
    // 23:58 → 00:03 UTC: two minutes on the 3rd, three on the 4th.
    await report(seeded, occurrence(), '2026-09-04T00:03:00Z', 300_000);

    // On the 10th, "7 days" starts at midnight on the 4th.
    expect(await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '7d')).toMatchObject({
      listenedMs: 180_000,
      // The play qualified 30 s in, on the 3rd.
      qualifyingPlays: 0,
    });
    expect(await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '30d')).toMatchObject({
      listenedMs: 300_000,
      qualifyingPlays: 1,
    });
  });

  it('lists listening per local day inside the range, days without listening left out', async () => {
    const seeded = await seed(600);
    // Two minutes on the 3rd, three on the 4th, one more on the 9th.
    await report(seeded, occurrence(), '2026-09-04T00:03:00Z', 300_000);
    await report(seeded, occurrence(), '2026-09-09T10:01:00Z', 60_000);

    expect((await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '7d')).daily).toEqual([
      { day: '2026-09-04', listenedMs: 180_000 },
      { day: '2026-09-09', listenedMs: 60_000 },
    ]);

    // Berlin's 4th opens at 22:00 UTC on the 3rd, so the whole first listen is on the 4th.
    instanceTimezone = 'Europe/Berlin';
    expect((await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '30d')).daily).toEqual([
      { day: '2026-09-04', listenedMs: 300_000 },
      { day: '2026-09-09', listenedMs: 60_000 },
    ]);
  });

  it('reaches no further back than the daily limit on all time', async () => {
    const seeded = await seed(600);
    await report(seeded, occurrence(), '2026-01-05T10:01:00Z', 60_000);
    await report(seeded, occurrence(), '2026-09-09T10:01:00Z', 60_000);

    const all = await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', 'all');
    expect(all.listenedMs).toBe(120_000);
    expect(all.daily).toEqual([{ day: '2026-09-09', listenedMs: 60_000 }]);
  });

  it('regroups past listening when the timezone changes', async () => {
    const seeded = await seed(600);
    await report(seeded, occurrence(), '2026-09-04T00:03:00Z', 300_000);
    await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z');

    // In Berlin (UTC+2) the 4th starts at 22:00 UTC on the 3rd, so all of it lands inside.
    instanceTimezone = 'Europe/Berlin';
    expect(await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '7d')).toMatchObject({
      timezone: 'Europe/Berlin',
      listenedMs: 300_000,
      qualifyingPlays: 1,
    });
  });

  it("follows the Instance's timezone setting when it changes", async () => {
    const seeded = await seed();
    await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z');
    instanceTimezone = 'Asia/Tokyo';
    expect((await stats(seeded.ownerUserId, '2026-09-11T12:00:00Z')).timezone).toBe('Asia/Tokyo');
  });

  it('reports when collection began and whether the range reaches before it', async () => {
    const seeded = await seed();
    const recent = await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '7d');
    expect(recent.collectionStartedAt).toBeInstanceOf(Date);
    // The account was created moments ago — long after a range anchored in early September.
    expect(recent.rangePredatesCollection).toBe(true);
    expect(recent.listenedMs).toBe(0);

    const allTime = await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', 'all');
    expect(allTime.from).toBeNull();
    expect(allTime.rangePredatesCollection).toBe(false);
  });

  /** Another Track of the same owner, with its own title and genre tags. */
  async function seedTagged(
    owner: { ownerUserId: string; sessionId: string } | null,
    title: string,
    genreTags: string[],
  ) {
    const seeded = await seedReadyTrack(ctx.db, owner ?? {});
    await ctx.db
      .update(tracks)
      .set({ durationSeconds: 180, title, genreTags })
      .where(eq(tracks.id, seeded.trackId));
    return seeded;
  }

  it('ranks most-played Tracks by qualifying plays, not by time, and counts every Track heard', async () => {
    const long = await seedTagged(null, 'One long listen', []);
    const replayed = await seedTagged(long, 'Replayed', []);
    const glimpsed = await seedTagged(long, 'Glimpsed', []);
    await report(long, occurrence(), '2026-09-10T10:30:00Z', 1_500_000);
    await report(replayed, occurrence(), '2026-09-10T11:01:00Z', 40_000);
    await report(replayed, occurrence(), '2026-09-10T11:02:00Z', 40_000);
    await report(glimpsed, occurrence(), '2026-09-10T11:03:00Z', 10_000);

    const result = await stats(long.ownerUserId, '2026-09-10T13:00:00Z');
    expect(result.uniqueTracks).toBe(3);
    expect(result.topTracks).toEqual([
      {
        trackId: replayed.trackId,
        title: 'Replayed',
        coverImageId: null,
        originSessionId: replayed.sessionId,
        plays: 2,
      },
      {
        trackId: long.trackId,
        title: 'One long listen',
        coverImageId: null,
        originSessionId: long.sessionId,
        plays: 1,
      },
    ]);
  });

  it('bounds the most-played list', async () => {
    const first = await seedTagged(null, 'T0', []);
    await report(first, occurrence(), '2026-09-10T10:01:00Z', 40_000);
    for (let i = 1; i < 12; i++) {
      const next = await seedTagged(first, `T${i}`, []);
      await report(next, occurrence(), '2026-09-10T11:01:00Z', 40_000);
    }
    const result = await stats(first.ownerUserId, '2026-09-10T13:00:00Z');
    expect(result.uniqueTracks).toBe(12);
    expect(result.topTracks).toHaveLength(10);
  });

  it('splits credited time, sub-threshold included, equally across normalized distinct genres', async () => {
    const two = await seedTagged(null, 'Two genres', [' Techno', 'techno', 'AMBIENT', '  ']);
    const untagged = await seedTagged(two, 'Untagged', []);
    await report(two, occurrence(), '2026-09-10T11:01:00Z', 60_000);
    // Never a play, still listening.
    await report(two, occurrence(), '2026-09-10T11:02:00Z', 20_000);
    await report(untagged, occurrence(), '2026-09-10T11:03:00Z', 10_000);

    const result = await stats(two.ownerUserId, '2026-09-10T13:00:00Z');
    expect(result.topGenres).toEqual([
      { genre: 'ambient', listenedMs: 40_000 },
      { genre: 'techno', listenedMs: 40_000 },
      { genre: null, listenedMs: 10_000 },
    ]);
  });

  it('ranks genres by the tags the Track had when heard, whatever it is tagged now', async () => {
    const seeded = await seedTagged(null, 'Retagged', ['jazz']);
    await report(seeded, occurrence(), '2026-09-10T11:01:00Z', 60_000);
    await ctx.db
      .update(tracks)
      .set({ genreTags: ['metal'] })
      .where(eq(tracks.id, seeded.trackId));

    const result = await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z');
    expect(result.topGenres).toEqual([{ genre: 'jazz', listenedMs: 60_000 }]);
  });

  it('keeps a deleted Track in the counts as an unnamed, unlinked entry', async () => {
    const kept = await seedTagged(null, 'Kept', ['jazz']);
    const gone = await seedTagged(kept, 'Gone', ['jazz']);
    await report(kept, occurrence(), '2026-09-10T11:01:00Z', 40_000);
    await report(gone, occurrence(), '2026-09-10T11:02:00Z', 40_000);
    await report(gone, occurrence(), '2026-09-10T11:03:00Z', 40_000);
    await ctx.db.delete(tracks).where(eq(tracks.id, gone.trackId));
    const coverImageId = await createCoverImage(ctx.db);
    await ctx.db.update(tracks).set({ coverImageId }).where(eq(tracks.id, kept.trackId));

    const result = await stats(kept.ownerUserId, '2026-09-10T13:00:00Z');
    expect(result.uniqueTracks).toBe(2);
    expect(result.topTracks).toEqual([
      { trackId: null, title: null, coverImageId: null, originSessionId: null, plays: 2 },
      {
        trackId: kept.trackId,
        title: 'Kept',
        coverImageId,
        originSessionId: kept.sessionId,
        plays: 1,
      },
    ]);
    expect(result.topGenres).toEqual([{ genre: 'jazz', listenedMs: 120_000 }]);
  });

  it("shows a Track under its Session's Cover, as every Track list does", async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T11:01:00Z', 40_000);
    const sessionCover = await createCoverImage(ctx.db);
    await ctx.db
      .update(tracks)
      .set({ coverImageId: await createCoverImage(ctx.db) })
      .where(eq(tracks.id, seeded.trackId));
    await ctx.db
      .update(activitySessions)
      .set({ coverImageId: sessionCover })
      .where(eq(activitySessions.id, seeded.sessionId));

    const result = await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z');
    expect(result.topTracks[0]?.coverImageId).toBe(sessionCover);
    expect(result.topTracks[0]?.originSessionId).toBe(seeded.sessionId);
  });

  it('cuts rankings at the local midnight of the range, and regroups them with the timezone', async () => {
    const seeded = await seedTagged(null, 'Midnight', ['dub']);
    // 23:58 → 00:03 UTC: two minutes and the play on the 3rd, three minutes on the 4th.
    await report(seeded, occurrence(), '2026-09-04T00:03:00Z', 300_000);

    const utc = await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '7d');
    expect(utc.topGenres).toEqual([{ genre: 'dub', listenedMs: 180_000 }]);
    expect(utc.uniqueTracks).toBe(1);
    expect(utc.topTracks).toEqual([]);

    instanceTimezone = 'Europe/Berlin';
    const berlin = await stats(seeded.ownerUserId, '2026-09-10T12:00:00Z', '7d');
    expect(berlin.topGenres).toEqual([{ genre: 'dub', listenedMs: 300_000 }]);
    expect(berlin.topTracks).toEqual([
      {
        trackId: seeded.trackId,
        title: 'Midnight',
        coverImageId: null,
        originSessionId: seeded.sessionId,
        plays: 1,
      },
    ]);
  });

  it("keeps another owner's Tracks and genres out of the rankings", async () => {
    const mine = await seedTagged(null, 'Mine', ['jazz']);
    const theirs = await seedTagged(null, 'Theirs', ['metal']);
    await report(mine, occurrence(), '2026-09-10T11:01:00Z', 40_000);
    await report(theirs, occurrence(), '2026-09-10T11:01:00Z', 40_000);

    const result = await stats(mine.ownerUserId, '2026-09-10T13:00:00Z');
    expect(result.uniqueTracks).toBe(1);
    expect(result.topTracks.map((entry) => entry.title)).toEqual(['Mine']);
    expect(result.topGenres.map((entry) => entry.genre)).toEqual(['jazz']);
  });

  describe('cached read', () => {
    function cached(ownerUserId: string, now: string, range: '7d' | '30d' | 'all' = '30d') {
      return getCachedListeningStats(ctx.db, {
        ownerUserId,
        range,
        now: new Date(now),
        timezone: instanceTimezone,
      });
    }

    it('answers the same owner and query from the cache, with dates intact', async () => {
      const seeded = await seedTagged(null, 'Before', ['jazz']);
      await report(seeded, occurrence(), '2026-09-10T11:01:00Z', 40_000);
      const measured = await cached(seeded.ownerUserId, '2026-09-10T13:00:00Z');

      // A rename changes no listening, so only a cached answer still carries the old title.
      await ctx.db.update(tracks).set({ title: 'After' }).where(eq(tracks.id, seeded.trackId));
      const served = await cached(seeded.ownerUserId, '2026-09-10T13:01:00Z');
      expect(served).toEqual(measured);
      expect(served.topTracks[0]?.title).toBe('Before');

      const aged = await cached(seeded.ownerUserId, '2026-09-10T13:10:00Z');
      expect(aged.topTracks[0]?.title).toBe('After');
    });

    it('measures again for new listening, another range, another timezone, and another owner', async () => {
      const seeded = await seedTagged(null, 'Mine', ['jazz']);
      const other = await seedTagged(null, 'Theirs', ['metal']);
      await report(seeded, occurrence(), '2026-09-01T11:01:00Z', 40_000);
      await report(other, occurrence(), '2026-09-10T11:01:00Z', 50_000);
      expect((await cached(seeded.ownerUserId, '2026-09-10T13:00:00Z')).listenedMs).toBe(40_000);

      expect((await cached(other.ownerUserId, '2026-09-10T13:00:00Z')).listenedMs).toBe(50_000);
      expect((await cached(seeded.ownerUserId, '2026-09-10T13:00:00Z', '7d')).listenedMs).toBe(0);

      await report(seeded, occurrence(), '2026-09-10T12:01:00Z', 60_000);
      expect((await cached(seeded.ownerUserId, '2026-09-10T13:00:30Z')).listenedMs).toBe(100_000);

      instanceTimezone = 'Asia/Tokyo';
      expect((await cached(seeded.ownerUserId, '2026-09-10T13:00:40Z')).timezone).toBe(
        'Asia/Tokyo',
      );
    });
  });

  it('keeps the totals after the Track row is gone', async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:01:00Z', 60_000);
    await ctx.db.delete(tracks).where(eq(tracks.id, seeded.trackId));
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject({
      listenedMs: 60_000,
      qualifyingPlays: 1,
    });
  });
});
