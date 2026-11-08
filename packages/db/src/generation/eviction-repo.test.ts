import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessionQueueItems, deletionQueueItems, trackAudioAssets, tracks } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { withTransaction } from '../transactions';
import {
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from './test-fixtures';
import { evictSessionEphemeralAudio } from './eviction-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('eviction repo (session-deletion audio reclaim)', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-eviction-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function chain(
    ownerUserId: string,
    sessionId: string,
  ): Promise<{ requestId: string; jobId: string }> {
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    return { requestId, jobId };
  }

  function evictSession(
    sessionId: string,
    ownerUserId: string,
  ): Promise<{ evictedTrackIds: string[] }> {
    return withTransaction(ctx.db, (tx) =>
      evictSessionEphemeralAudio(tx, { sessionId, ownerUserId }),
    );
  }

  it('reclaims every Ephemeral track’s stored audio and nothing a retention rule holds', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const { requestId, jobId } = await chain(ownerUserId, sessionId);
    const base = { ownerUserId, generationRequestId: requestId, providerJobId: jobId };
    // Ephemeral and stored: the one track the reclaim is for. Its provider-stream
    // asset carries no storage key — the row still goes, nothing is queued for it.
    const ephemeral = await createTrack(ctx.db, {
      ...base,
      status: 'ready',
      audioStorageKey: 'a/ephemeral.mp3',
      streamEncryptedSourceUrl: 'enc:stream-url',
    });
    const saved = await createTrack(ctx.db, {
      ...base,
      status: 'ready',
      savedAt: new Date(),
      audioStorageKey: 'a/saved.mp3',
    });
    // The Reject purge already queued the Disliked track's audio on its own terms.
    const disliked = await createTrack(ctx.db, {
      ...base,
      status: 'ready',
      dislikedAt: new Date(),
      audioStorageKey: 'a/disliked.mp3',
    });
    // Nothing stored yet (still streaming): no audio to reclaim, so no tombstone.
    const streamOnly = await createTrack(ctx.db, {
      ...base,
      status: 'ready',
      streamEncryptedSourceUrl: 'enc:stream-only',
    });

    expect((await evictSession(sessionId, ownerUserId)).evictedTrackIds).toEqual([ephemeral]);

    const statuses = new Map(
      (await ctx.db.select({ id: tracks.id, status: tracks.status }).from(tracks)).map((row) => [
        row.id,
        row.status,
      ]),
    );
    expect(statuses.get(ephemeral)).toBe('deleted'); // the ROW persists (History / re-Save)
    for (const trackId of [saved, disliked, streamOnly]) {
      expect(statuses.get(trackId)).toBe('ready');
    }

    // Exactly the reclaimed track's stored key is queued, and only its asset rows
    // are dropped — a queued key with a surviving asset row would delete live audio.
    const queued = await ctx.db.select().from(deletionQueueItems);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      trackId: ephemeral,
      ownerUserId,
      storageKey: 'a/ephemeral.mp3',
      reason: 'ephemeral_eviction',
    });
    const assetTrackIds = (
      await ctx.db.select({ trackId: trackAudioAssets.trackId }).from(trackAudioAssets)
    ).map((row) => row.trackId);
    expect(assetTrackIds.sort()).toEqual([disliked, saved, streamOnly].sort());
  });

  it('transitions the evicted track’s live queue item to failed and leaves terminal ones', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const { requestId, jobId } = await chain(ownerUserId, sessionId);
    const base = { ownerUserId, generationRequestId: requestId, providerJobId: jobId };
    const queuedTrack = await createTrack(ctx.db, {
      ...base,
      status: 'ready',
      audioStorageKey: 'a/stopped-queued.mp3',
    });
    const playedTrack = await createTrack(ctx.db, {
      ...base,
      status: 'ready',
      audioStorageKey: 'a/stopped-played.mp3',
    });
    const queuedItem = await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId: queuedTrack,
      position: 1,
      state: 'queued',
    });
    const playedItem = await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId: playedTrack,
      position: 0,
      state: 'played',
    });

    expect((await evictSession(sessionId, ownerUserId)).evictedTrackIds.sort()).toEqual(
      [queuedTrack, playedTrack].sort(),
    );

    const states = new Map(
      (
        await ctx.db
          .select({ id: activitySessionQueueItems.id, state: activitySessionQueueItems.state })
          .from(activitySessionQueueItems)
          .where(eq(activitySessionQueueItems.activitySessionId, sessionId))
      ).map((row) => [row.id, row.state]),
    );
    // The live slot no longer counts as buffer fill (audio lost → failed); the
    // terminal slot keeps its history.
    expect(states.get(queuedItem)).toBe('failed');
    expect(states.get(playedItem)).toBe('played');
  });

  /**
   * A track of the deleted session that ANOTHER, still-active session holds in a
   * queue slot — the case the active-session guard exists for. `state` decides:
   * a live slot is about to play the track, a terminal one is history.
   */
  async function seedTrackHeldByActiveSession(state: 'queued' | 'played') {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const activeSession = await createSession(ctx.db, { ownerUserId, status: 'active' });
    const { requestId, jobId } = await chain(ownerUserId, sessionId);
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'ready',
      audioStorageKey: `a/held-${state}.mp3`,
    });
    await createQueueItem(ctx.db, {
      activitySessionId: activeSession,
      trackId,
      position: 0,
      state,
    });
    return { ownerUserId, sessionId, trackId };
  }

  it('refuses a track held by a LIVE queue item of an ACTIVE session', async () => {
    const { ownerUserId, sessionId, trackId } = await seedTrackHeldByActiveSession('queued');

    expect((await evictSession(sessionId, ownerUserId)).evictedTrackIds).toEqual([]);
    const [row] = await ctx.db.select().from(tracks).where(eq(tracks.id, trackId));
    expect(row!.status).toBe('ready'); // untouched
  });

  it('still evicts a track whose active-session queue items are all terminal', async () => {
    const { ownerUserId, sessionId, trackId } = await seedTrackHeldByActiveSession('played');

    expect((await evictSession(sessionId, ownerUserId)).evictedTrackIds).toEqual([trackId]);
  });

  describe('sweepOrphanedTracks (the recurring safety net)', () => {
    it('reclaims session-less Ephemeral tracks across owners; session-backed ones survive', async () => {
      const firstOwner = await createUser(ctx.db);
      const secondOwner = await createUser(ctx.db);
      // Orphan: request without a session edge (as after a session delete).
      const orphanRequest = await createGenerationRequest(ctx.db, { ownerUserId: firstOwner });
      const orphanJob = await createProviderJob(ctx.db, { generationRequestId: orphanRequest });
      const orphan = await createTrack(ctx.db, {
        ownerUserId: firstOwner,
        generationRequestId: orphanRequest,
        providerJobId: orphanJob,
        status: 'ready',
        audioStorageKey: 'a/orphan.mp3',
      });
      // Ephemeral but its session still exists, so it persists.
      const sessionId = await createSession(ctx.db, {
        ownerUserId: secondOwner,
        status: 'stopped',
      });
      const { requestId, jobId } = await chain(secondOwner, sessionId);
      const backed = await createTrack(ctx.db, {
        ownerUserId: secondOwner,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'ready',
        audioStorageKey: 'a/backed.mp3',
      });

      const { sweepOrphanedTracks } = await import('./eviction-repo');
      const result = await sweepOrphanedTracks(ctx.db, { limit: 10 });

      expect(result.evictedTrackIds).toEqual([orphan]);
      const [orphanRow] = await ctx.db.select().from(tracks).where(eq(tracks.id, orphan));
      expect(orphanRow!.status).toBe('deleted');
      const queued = await ctx.db
        .select()
        .from(deletionQueueItems)
        .where(eq(deletionQueueItems.trackId, orphan));
      expect(queued).toHaveLength(1);
      expect(queued[0]!.reason).toBe('orphan_cleanup');
      const [backedRow] = await ctx.db.select().from(tracks).where(eq(tracks.id, backed));
      expect(backedRow!.status).toBe('ready');

      // Idempotent: a second run finds nothing.
      expect((await sweepOrphanedTracks(ctx.db, { limit: 10 })).evictedTrackIds).toEqual([]);
    });

    it('never touches a Disliked track (the Reject purge owns it)', async () => {
      const ownerUserId = await createUser(ctx.db);
      const requestId = await createGenerationRequest(ctx.db, { ownerUserId });
      const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
      const disliked = await createTrack(ctx.db, {
        ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'ready',
        dislikedAt: new Date(),
        audioStorageKey: 'a/disliked.mp3',
      });

      const { sweepOrphanedTracks } = await import('./eviction-repo');
      expect((await sweepOrphanedTracks(ctx.db, { limit: 10 })).evictedTrackIds).toEqual([]);
      const [row] = await ctx.db.select().from(tracks).where(eq(tracks.id, disliked));
      expect(row!.status).toBe('ready');
    });
  });
});
