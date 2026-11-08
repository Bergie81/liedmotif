import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { activitySessions, generationOutputs, tracks } from '../schema';
import { GENERATION_FIXTURE_TABLES, seedReadyTrack } from '../generation/test-fixtures';
import { deleteTrack } from '../generation/delete-track-repo';
import { rejectDislikedTrack } from '../generation/feedback-repo';
import { deleteSession } from '../generation/session-delete-repo';
import { getGenerationStats } from './generation-repo';
import { clearListeningHistory } from './history-repo';
import { getCachedListeningStats, getListeningStats, recordListening } from './listening-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const TABLES = [
  'listening_occurrences',
  'listening_preferences',
  'generation_outputs',
  'user_settings',
  ...GENERATION_FIXTURE_TABLES,
];

describeIfDb('deletion privacy and clearing listening history', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-history-privacy-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, TABLES);
  });

  let nextOccurrence = 0;
  const occurrence = () => `00000000-0000-4000-9000-${String(nextOccurrence++).padStart(12, '0')}`;

  type Seeded = Awaited<ReturnType<typeof seedReadyTrack>>;

  /** A Track with genre tags and its ledger row, as first playability leaves them. */
  async function seed(overrides: Parameters<typeof seedReadyTrack>[1] = {}) {
    const seeded = await seedReadyTrack(ctx.db, overrides);
    const [track] = await ctx.db
      .update(tracks)
      .set({ durationSeconds: 180, genreTags: ['Techno'], title: 'Night Drive' })
      .where(eq(tracks.id, seeded.trackId))
      .returning({ analyticsId: tracks.analyticsId });
    await ctx.db.insert(generationOutputs).values({
      ownerUserId: seeded.ownerUserId,
      analyticsTrackId: track!.analyticsId,
      trackId: seeded.trackId,
      firstPlayableAt: new Date('2026-09-10T11:00:00Z'),
    });
    return seeded;
  }

  function report(seeded: Seeded, occurrenceId: string, at: string, listenedMs: number, now = at) {
    const clientTimestamp = new Date(at);
    return recordListening(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      occurrenceId,
      trackId: seeded.trackId,
      sessionId: seeded.sessionId,
      surface: 'session',
      startedAt: new Date(clientTimestamp.getTime() - listenedMs),
      listenedMs,
      playedMs: listenedMs,
      origin: 'auto',
      clientTimestamp,
      endReason: null,
      now: new Date(now),
    });
  }

  const query = (ownerUserId: string, now: string) => ({
    ownerUserId,
    range: 'all' as const,
    now: new Date(now),
    timezone: 'UTC',
  });
  const stats = (ownerUserId: string, now: string) =>
    getListeningStats(ctx.db, query(ownerUserId, now));

  const HEARD = {
    listenedMs: 40_000,
    qualifyingPlays: 1,
    uniqueTracks: 1,
    topGenres: [{ genre: 'techno', listenedMs: 40_000 }],
  };
  const NAMED = { ...HEARD, topTracks: [{ title: 'Night Drive', plays: 1 }] };
  const UNNAMED = { ...HEARD, topTracks: [{ trackId: null, title: null, plays: 1 }] };

  async function linkedRows(ownerUserId: string) {
    const rows = await ctx.pool.query(
      `select
         (select count(*) from listening_occurrences
            where owner_user_id = $1 and (track_id is not null or session_id is not null))::int as listening,
         (select count(*) from generation_outputs
            where owner_user_id = $1 and track_id is not null)::int as outputs,
         (select count(*) from tracks t
            where t.owner_user_id = $1 and (
              exists (select 1 from listening_occurrences o where o.analytics_track_id = t.analytics_id)
              or exists (select 1 from generation_outputs g where g.analytics_track_id = t.analytics_id)
            ))::int as resolvable`,
      [ownerUserId],
    );
    return rows.rows[0];
  }

  it('keeps the counts of a deleted Track and forgets which Track it was', async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:00:40Z', 40_000);
    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject(NAMED);

    await deleteTrack(ctx.db, { ownerUserId: seeded.ownerUserId, trackId: seeded.trackId });

    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject(UNNAMED);
    expect(
      await getGenerationStats(ctx.db, query(seeded.ownerUserId, '2026-09-10T13:00:00Z')),
    ).toMatchObject({ generatedTracks: 1, neverHeardTracks: 0 });
    expect(await linkedRows(seeded.ownerUserId)).toEqual({
      listening: 0,
      outputs: 0,
      resolvable: 0,
    });
  });

  it('stops naming a deleted Track in an answer cached before the deletion', async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:00:40Z', 40_000);
    const cachedStats = () =>
      getCachedListeningStats(ctx.db, query(seeded.ownerUserId, '2026-09-10T13:00:00Z'));
    expect(await cachedStats()).toMatchObject(NAMED);

    await deleteTrack(ctx.db, { ownerUserId: seeded.ownerUserId, trackId: seeded.trackId });

    expect(await cachedStats()).toMatchObject(UNNAMED);
  });

  it('forgets a Disliked Track at once, without waiting for its delayed file cleanup', async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:00:40Z', 40_000);

    await rejectDislikedTrack(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      trackId: seeded.trackId,
      activitySessionId: seeded.sessionId,
    });

    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject(UNNAMED);
    const links = await ctx.pool.query(
      `select count(*)::int as n from listening_occurrences where track_id is not null`,
    );
    expect(links.rows[0].n).toBe(0);
  });

  it('forgets the Session and its evicted Tracks when a Session is deleted', async () => {
    const seeded = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:00:40Z', 40_000);
    await ctx.db
      .update(activitySessions)
      .set({ status: 'stopped' })
      .where(eq(activitySessions.id, seeded.sessionId));

    const result = await deleteSession(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      sessionId: seeded.sessionId,
    });
    expect(result).toMatchObject({ ok: true, evictedTrackCount: 1 });

    expect(await stats(seeded.ownerUserId, '2026-09-10T13:00:00Z')).toMatchObject(UNNAMED);
    expect(await linkedRows(seeded.ownerUserId)).toEqual({
      listening: 0,
      outputs: 0,
      resolvable: 0,
    });
  });

  it('refuses a late report for a deleted Track, so nothing links to its tombstone', async () => {
    const seeded = await seed();
    await deleteTrack(ctx.db, { ownerUserId: seeded.ownerUserId, trackId: seeded.trackId });

    expect(await report(seeded, occurrence(), '2026-09-10T12:00:40Z', 40_000)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await linkedRows(seeded.ownerUserId)).toMatchObject({ listening: 0, resolvable: 0 });
  });

  it('clears listening while music, generated totals and another owner stay untouched', async () => {
    const seeded = await seed();
    const other = await seed();
    await report(seeded, occurrence(), '2026-09-10T12:00:40Z', 40_000);
    await report(other, occurrence(), '2026-09-10T12:00:40Z', 40_000);
    await getCachedListeningStats(ctx.db, query(seeded.ownerUserId, '2026-09-10T13:00:00Z'));

    const clearedAt = new Date('2026-09-10T13:01:00Z');
    await clearListeningHistory(ctx.db, { ownerUserId: seeded.ownerUserId, now: clearedAt });

    expect(
      await getCachedListeningStats(ctx.db, query(seeded.ownerUserId, '2026-09-10T13:02:00Z')),
    ).toMatchObject({
      listenedMs: 0,
      qualifyingPlays: 0,
      uniqueTracks: 0,
      topTracks: [],
      topGenres: [],
      collectionStartedAt: clearedAt,
    });
    // Output heard before the clearing is of unknown coverage, never "never heard".
    expect(
      await getGenerationStats(ctx.db, query(seeded.ownerUserId, '2026-09-10T13:02:00Z')),
    ).toMatchObject({ generatedTracks: 1, neverHeardTracks: 0, unknownCoverageTracks: 1 });
    const [track] = await ctx.db.select().from(tracks).where(eq(tracks.id, seeded.trackId));
    expect(track).toMatchObject({ status: 'ready', title: 'Night Drive' });
    expect(await stats(other.ownerUserId, '2026-09-10T13:02:00Z')).toMatchObject(NAMED);
  });

  it('refuses a late report from before the clearing and records listening begun after it', async () => {
    const seeded = await seed();
    const before = occurrence();
    await report(seeded, before, '2026-09-10T12:00:40Z', 40_000);
    await clearListeningHistory(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      now: new Date('2026-09-10T12:01:00Z'),
    });

    // The same occurrence, retried or still running after the clearing.
    expect(
      await report(seeded, before, '2026-09-10T12:01:30Z', 90_000, '2026-09-10T12:01:30Z'),
    ).toEqual({ ok: false, reason: 'cleared' });
    // A client whose clock runs ahead claims a later start; its elapsed time still gives it away.
    const clientTimestamp = new Date('2026-09-10T12:04:00Z');
    expect(
      await recordListening(ctx.db, {
        ownerUserId: seeded.ownerUserId,
        occurrenceId: occurrence(),
        trackId: seeded.trackId,
        sessionId: seeded.sessionId,
        surface: 'session',
        startedAt: new Date('2026-09-10T12:02:30Z'),
        listenedMs: 90_000,
        playedMs: 90_000,
        origin: 'auto',
        clientTimestamp,
        endReason: null,
        now: new Date('2026-09-10T12:01:30Z'),
      }),
    ).toEqual({ ok: false, reason: 'cleared' });
    expect(await stats(seeded.ownerUserId, '2026-09-10T12:05:00Z')).toMatchObject({
      listenedMs: 0,
      uniqueTracks: 0,
    });

    await report(seeded, occurrence(), '2026-09-10T12:02:40Z', 40_000);
    expect(await stats(seeded.ownerUserId, '2026-09-10T12:05:00Z')).toMatchObject(NAMED);
  });
});
