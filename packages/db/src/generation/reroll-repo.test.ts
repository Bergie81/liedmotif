import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  markTrackPlayed,
} from './test-fixtures';
import { withTransaction } from '../transactions';
import {
  clearPendingRerolls,
  consumePendingReroll,
  findUnplayedSibling,
  getTrackRerollContext,
  markTrackRerollPending,
  peekPendingRerollIdentity,
} from './reroll-repo';
import { activitySessions, tracks } from '../schema';
import { eq } from 'drizzle-orm';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('reroll repo — unplayed sibling', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-reroll-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  /** Two sibling tracks from one ProviderJob (N=2 for Suno). */
  async function siblingPair(): Promise<{
    ownerUserId: string;
    sessionId: string;
    jobId: string;
    a: string;
    b: string;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const base = {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'ready' as const,
    };
    const a = await createTrack(ctx.db, { ...base, providerTrackId: 'job-a' });
    const b = await createTrack(ctx.db, { ...base, providerTrackId: 'job-b' });
    return { ownerUserId, sessionId, jobId, a, b };
  }

  it('returns the unplayed sibling of a disliked track (no fresh call needed)', async () => {
    const { ownerUserId, sessionId, a, b } = await siblingPair();
    // 'a' was the one playing → disliked; 'b' is its never-played sibling.
    await markTrackPlayed(ctx.db, { ownerUserId, activitySessionId: sessionId, trackId: a });

    const sibling = await findUnplayedSibling(ctx.db, { dislikedTrackId: a });
    expect(sibling).toBe(b);
  });

  it('returns a sibling that is still streaming (final download pending)', async () => {
    const { a, b } = await siblingPair();
    await ctx.db.update(tracks).set({ status: 'streamable' }).where(eq(tracks.id, b));

    expect(await findUnplayedSibling(ctx.db, { dislikedTrackId: a })).toBe(b);
  });

  it('returns null when every sibling has already been played', async () => {
    const { ownerUserId, sessionId, a, b } = await siblingPair();
    await markTrackPlayed(ctx.db, { ownerUserId, activitySessionId: sessionId, trackId: b });

    const sibling = await findUnplayedSibling(ctx.db, { dislikedTrackId: a });
    expect(sibling).toBeNull();
  });

  it('never returns a disliked/rejected sibling', async () => {
    const { ownerUserId, sessionId, a, b } = await siblingPair();
    // Mark the only sibling disliked → it is a Reject, not a serveable alternate.
    await ctx.pool.query(
      `update tracks set disliked_at = now(), status = 'rejected' where id = $1`,
      [b],
    );

    const sibling = await findUnplayedSibling(ctx.db, { dislikedTrackId: a });
    expect(sibling).toBeNull();
    void ownerUserId;
    void sessionId;
  });

  it('does not cross ProviderJob boundaries (a different job is not a sibling)', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });

    // The disliked track is the ONLY track in its provider job (no sibling).
    const reqA = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobA = await createProviderJob(ctx.db, { generationRequestId: reqA });
    const lonely = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: reqA,
      providerJobId: jobA,
      providerTrackId: 'lonely',
      status: 'ready',
    });

    // A ready, unplayed track from a SEPARATE provider job — same session, but NOT a sibling.
    const reqB = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobB = await createProviderJob(ctx.db, { generationRequestId: reqB });
    await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: reqB,
      providerJobId: jobB,
      providerTrackId: 'other-job',
      status: 'ready',
    });

    const sibling = await findUnplayedSibling(ctx.db, { dislikedTrackId: lonely });
    expect(sibling).toBeNull(); // a different job's track is never a sibling
  });
});

describeIfDb('reroll repo — fresh-call reroll identity', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-reroll-identity-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function seedDisliked(opts: { stylePrompt?: string | null } = {}): Promise<{
    ownerUserId: string;
    sessionId: string;
    trackId: string;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt:
        opts.stylePrompt === undefined ? 'old vibe style, 92 bpm, D minor' : opts.stylePrompt,
      styleRevision: 1,
      targetBpm: 92,
      targetKey: 'D minor',
      styleSnapshot: { stylePrompt: 'old vibe style', bpm: 92, key: 'D minor' },
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'rejected',
      dislikedAt: new Date(),
    });
    return { ownerUserId, sessionId, trackId };
  }

  /** Peek + consume in one transaction — what the buffer tick does on a real submit. */
  const claim = (sessionId: string) =>
    withTransaction(ctx.db, async (tx) => {
      const pending = await peekPendingRerollIdentity(tx, sessionId);
      if (pending) await consumePendingReroll(tx, pending.trackId);
      return pending;
    });

  it('marks a disliked track and the claim returns its request identity once', async () => {
    const { ownerUserId, sessionId, trackId } = await seedDisliked();
    const { marked } = await markTrackRerollPending(ctx.db, { ownerUserId, trackId });
    expect(marked).toBe(true);

    const identity = await claim(sessionId);
    expect(identity).toMatchObject({
      trackId,
      stylePrompt: 'old vibe style, 92 bpm, D minor',
      styleRevision: 1,
      targetBpm: 92,
      targetKey: 'D minor',
      // The full compilation context rides along — the canonical reroll path
      // re-runs the normal compiler over it.
      styleSnapshot: { stylePrompt: 'old vibe style', bpm: 92, key: 'D minor' },
    });

    // Consumed: a second claim finds nothing.
    expect(await claim(sessionId)).toBeNull();
  });

  it('peek does NOT consume: a blocked/waiting tick leaves the intent pending', async () => {
    const { ownerUserId, sessionId, trackId } = await seedDisliked();
    await markTrackRerollPending(ctx.db, { ownerUserId, trackId });

    // Two peeks in a row both see it — only an explicit consume clears it.
    const first = await withTransaction(ctx.db, (tx) => peekPendingRerollIdentity(tx, sessionId));
    expect(first?.trackId).toBe(trackId);
    const second = await withTransaction(ctx.db, (tx) => peekPendingRerollIdentity(tx, sessionId));
    expect(second?.trackId).toBe(trackId);

    expect((await claim(sessionId))?.trackId).toBe(trackId);
    expect(await claim(sessionId)).toBeNull();
  });

  it('refuses to mark a track that is not disliked', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const trackId = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      status: 'ready',
    });

    const { marked } = await markTrackRerollPending(ctx.db, { ownerUserId, trackId });
    expect(marked).toBe(false);
    expect(await claim(sessionId)).toBeNull();
  });

  it('is owner-scoped: a foreign owner cannot mark the track (IDOR posture)', async () => {
    const { sessionId, trackId } = await seedDisliked();
    const stranger = await createUser(ctx.db);
    const { marked } = await markTrackRerollPending(ctx.db, { ownerUserId: stranger, trackId });
    expect(marked).toBe(false);
    expect(await claim(sessionId)).toBeNull();
  });

  it('consumes multiple pending rerolls oldest-first', async () => {
    const { ownerUserId, sessionId, trackId: first } = await seedDisliked();
    // Second disliked track in the SAME session with its own request identity.
    const secondRequest = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: 'second style',
      styleRevision: 2,
      targetBpm: 120,
      targetKey: 'A minor',
    });
    const secondJob = await createProviderJob(ctx.db, { generationRequestId: secondRequest });
    const second = await createTrack(ctx.db, {
      ownerUserId,
      generationRequestId: secondRequest,
      providerJobId: secondJob,
      status: 'rejected',
      dislikedAt: new Date(),
    });

    await markTrackRerollPending(ctx.db, {
      ownerUserId,
      trackId: first,
      now: new Date('2026-07-10T10:00:00Z'),
    });
    await markTrackRerollPending(ctx.db, {
      ownerUserId,
      trackId: second,
      now: new Date('2026-07-10T10:00:01Z'),
    });

    expect((await claim(sessionId))?.trackId).toBe(first);
    expect((await claim(sessionId))?.trackId).toBe(second);
    expect(await claim(sessionId)).toBeNull();
  });

  it('does not leak pending rerolls across sessions', async () => {
    const a = await seedDisliked();
    const b = await seedDisliked();
    await markTrackRerollPending(ctx.db, { ownerUserId: a.ownerUserId, trackId: a.trackId });

    expect(await claim(b.sessionId)).toBeNull();
    expect((await claim(a.sessionId))?.trackId).toBe(a.trackId);
  });

  it('clears one session’s pending rerolls and leaves another session’s alone', async () => {
    const a = await seedDisliked();
    const b = await seedDisliked();
    await markTrackRerollPending(ctx.db, { ownerUserId: a.ownerUserId, trackId: a.trackId });
    await markTrackRerollPending(ctx.db, { ownerUserId: b.ownerUserId, trackId: b.trackId });

    await withTransaction(ctx.db, (tx) => clearPendingRerolls(tx, a.sessionId));

    expect(await claim(a.sessionId)).toBeNull();
    expect((await claim(b.sessionId))?.trackId).toBe(b.trackId);
  });

  it('reads the Session mode and vibe revision that govern a Track’s reroll', async () => {
    const { sessionId, trackId } = await seedDisliked(); // request at revision 1
    expect(await getTrackRerollContext(ctx.db, { trackId })).toEqual({
      sessionMode: 'keep_going',
      vibeSuperseded: false,
    });

    // A Change Vibe since (live revision 2) and a switch to Repeat.
    await ctx.db
      .update(activitySessions)
      .set({ sessionMode: 'repeat', styleRevision: 2 })
      .where(eq(activitySessions.id, sessionId));
    expect(await getTrackRerollContext(ctx.db, { trackId })).toEqual({
      sessionMode: 'repeat',
      vibeSuperseded: true,
    });
  });

  it('reports no context for a track with no session', async () => {
    expect(
      await getTrackRerollContext(ctx.db, { trackId: '00000000-0000-0000-0000-000000000000' }),
    ).toBeNull();
  });
});
