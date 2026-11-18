import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  createGenerationRequest,
  createProviderJob,
  createQueueItem,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
} from './test-fixtures';
import {
  countInFlightSessionJobs,
  countReadyAheadTracks,
  countSessionOwnReadyTracks,
  getBufferSessionCounts,
  getLatestProviderJobState,
  getSessionForBuffer,
  listSessionLoopCandidates,
  setGenerationStatus,
} from './sessions-repo';
import { READY_MISSING_TRACKS_RECENCY_MS } from './provider-poll-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('sessions repo — buffer controller reads/writes', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-sessions-controller-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  it('loads the buffer-relevant session fields incl. the stored snapshot', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      sessionMode: 'repeat',
      styleSnapshot: { stylePrompt: 'instrumental', bpm: 100, key: 'A minor' },
    });
    const session = await getSessionForBuffer(ctx.db, sessionId);
    expect(session?.status).toBe('active');
    expect(session?.sessionMode).toBe('repeat');
    expect(session?.snapshot?.bpm).toBe(100);
  });

  it('writes generationStatus (the controller-only field)', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    await setGenerationStatus(ctx.db, {
      sessionId,
      status: 'repeat_cost_limit',
      statusMessageSafe: 'Daily limit reached — replaying this session.',
    });
    const [row] = await ctx.db
      .select()
      .from(activitySessions)
      .where(eq(activitySessions.id, sessionId));
    expect(row!.generationStatus).toBe('repeat_cost_limit');
    expect(row!.statusMessageSafe).toContain('Daily limit');
  });

  it('counts ready-ahead queue items and the session own ready tracks', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const base = { ownerUserId, generationRequestId: requestId, providerJobId: jobId };

    const t1 = await createTrack(ctx.db, { ...base, status: 'ready' });
    const t2 = await createTrack(ctx.db, { ...base, status: 'ready' });
    const t3 = await createTrack(ctx.db, { ...base, status: 'pending' }); // not ready yet

    await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId: t1,
      position: 1,
      state: 'queued',
    });
    await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId: t2,
      position: 2,
      state: 'planned',
    });
    // A `played` slot (distinct track — a track is queued at most once per session) so
    // the ready-ahead count is shown to exclude already-played items.
    await createQueueItem(ctx.db, {
      activitySessionId: sessionId,
      trackId: t3,
      position: 0,
      state: 'played',
    });

    expect(await countReadyAheadTracks(ctx.db, sessionId)).toBe(2); // queued + planned
    expect(await countSessionOwnReadyTracks(ctx.db, sessionId)).toBe(2); // t1, t2
    expect((await listSessionLoopCandidates(ctx.db, sessionId)).sort()).toEqual([t1, t2].sort());
  });

  it('reports the latest provider-job state for the session, incl. the submitted style', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const r1 = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: 'instrumental lofi, 96 bpm, A minor',
    });
    await createProviderJob(ctx.db, {
      generationRequestId: r1,
      normalizedStatus: 'blocked_by_provider_credits',
    });

    const state = await getLatestProviderJobState(ctx.db, sessionId);
    expect(state?.normalizedStatus).toBe('blocked_by_provider_credits');
    expect(state?.stylePrompt).toBe('instrumental lofi, 96 bpm, A minor');
  });

  it('counts live in-flight jobs regardless of age, phantom submit states only while young', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    const NOW = new Date('2026-06-29T12:00:00Z');
    const CUTOFF = new Date(NOW.getTime() - 15 * 60_000);
    const OLD = new Date(NOW.getTime() - 60 * 60_000);

    async function job(fx: {
      submitState: 'submitting' | 'submitted' | 'submit_unknown';
      normalizedStatus: string;
      updatedAt: Date;
    }): Promise<void> {
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId,
        activitySessionId: sessionId,
      });
      await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        ...(fx.submitState === 'submit_unknown' ? { providerTaskId: null } : {}),
        ...fx,
      });
    }

    // Live pipeline work counts however old — the poll loop owns terminalizing it.
    await job({ submitState: 'submitted', normalizedStatus: 'processing', updatedAt: OLD });
    // A young parked submit holds its slot (money safety for the submit retry)…
    await job({
      submitState: 'submit_unknown',
      normalizedStatus: 'submit_unknown',
      updatedAt: NOW,
    });
    expect(await countInFlightSessionJobs(ctx.db, { sessionId, phantomSubmitCutoff: CUTOFF })).toBe(
      2,
    );

    // …but an EXPIRED phantom (parked submit / crashed mid-submit) releases it, so
    // one transient submit error can never satisfy the watermark forever. The bound is
    // STRICT (`>` cutoff): at exactly the cutoff the slot is gone, mirroring the
    // worker's `ageMs < PHANTOM_SUBMIT_MAX_AGE_MS` stall window so signal and slot
    // clear on the same tick.
    await job({
      submitState: 'submit_unknown',
      normalizedStatus: 'submit_unknown',
      updatedAt: OLD,
    });
    await job({ submitState: 'submitting', normalizedStatus: 'queued', updatedAt: OLD });
    await job({
      submitState: 'submit_unknown',
      normalizedStatus: 'submit_unknown',
      updatedAt: CUTOFF,
    });
    expect(await countInFlightSessionJobs(ctx.db, { sessionId, phantomSubmitCutoff: CUTOFF })).toBe(
      2,
    );
  });

  describe('incoming supply in Tracks', () => {
    const NOW = new Date('2026-06-29T12:00:00Z');
    const CUTOFF = new Date(NOW.getTime() - 15 * 60_000);

    async function session(): Promise<{ ownerUserId: string; sessionId: string }> {
      const ownerUserId = await createUser(ctx.db);
      const sessionId = await createSession(ctx.db, { ownerUserId });
      return { ownerUserId, sessionId };
    }

    /** One request (2 Tracks asked for) with its provider job. */
    async function batch(
      s: { ownerUserId: string; sessionId: string },
      fx: {
        normalizedStatus: string;
        submitState?: 'submitting' | 'submitted' | 'submit_unknown';
        requestStatus?: string;
        styleRevision?: number;
        updatedAt?: Date;
      },
    ): Promise<{ requestId: string; jobId: string }> {
      const requestId = await createGenerationRequest(ctx.db, {
        ownerUserId: s.ownerUserId,
        activitySessionId: s.sessionId,
        status: fx.requestStatus ?? 'awaiting_results',
        ...(fx.styleRevision !== undefined ? { styleRevision: fx.styleRevision } : {}),
      });
      const jobId = await createProviderJob(ctx.db, {
        generationRequestId: requestId,
        normalizedStatus: fx.normalizedStatus,
        submitState: fx.submitState ?? 'submitted',
        ...(fx.submitState === 'submit_unknown' ? { providerTaskId: null } : {}),
        ...(fx.updatedAt ? { updatedAt: fx.updatedAt } : {}),
      });
      return { requestId, jobId };
    }

    async function incoming(sessionId: string, supplyAtOrAboveStyleRevision?: number) {
      return getBufferSessionCounts(ctx.db, {
        sessionId,
        now: NOW,
        phantomSubmitCutoff: CUTOFF,
        supplyAtOrAboveStyleRevision,
      });
    }

    it('a job whose Tracks are already in the Queue owes no further supply', async () => {
      const s = await session();
      const { requestId, jobId } = await batch(s, { normalizedStatus: 'partially_ready' });
      const base = {
        ownerUserId: s.ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
      };
      const played = await createTrack(ctx.db, { ...base, status: 'streamable' });
      const waiting = await createTrack(ctx.db, { ...base, status: 'streamable' });
      await createQueueItem(ctx.db, {
        activitySessionId: s.sessionId,
        trackId: played,
        position: 0,
        state: 'played',
      });
      await createQueueItem(ctx.db, {
        activitySessionId: s.sessionId,
        trackId: waiting,
        position: 1,
        state: 'queued',
      });

      const counts = await incoming(s.sessionId);
      expect(counts.readyAhead).toBe(1);
      expect(counts.incomingTracks).toBe(0);
    });

    it('a job with one of two Tracks created owes one', async () => {
      const s = await session();
      const { requestId, jobId } = await batch(s, { normalizedStatus: 'processing' });
      await createTrack(ctx.db, {
        ownerUserId: s.ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'pending',
      });
      expect((await incoming(s.sessionId)).incomingTracks).toBe(1);
    });

    it('a ready job with no Tracks yet owes two; a settled or failed one owes nothing', async () => {
      const s = await session();
      await batch(s, { normalizedStatus: 'ready' });
      const settled = await batch(s, { normalizedStatus: 'ready', requestStatus: 'materialized' });
      await createTrack(ctx.db, {
        ownerUserId: s.ownerUserId,
        generationRequestId: settled.requestId,
        providerJobId: settled.jobId,
      });
      await batch(s, { normalizedStatus: 'failed_final' });
      expect((await incoming(s.sessionId)).incomingTracks).toBe(2);
    });

    it('a ready job past the recovery window owes nothing, so a lost settle cannot stall the Buffer', async () => {
      const s = await session();
      await batch(s, {
        normalizedStatus: 'ready',
        updatedAt: new Date(NOW.getTime() - READY_MISSING_TRACKS_RECENCY_MS - 60_000),
      });
      expect((await incoming(s.sessionId)).incomingTracks).toBe(0);
    });

    it('a job whose created Track was rejected does not owe it again', async () => {
      const s = await session();
      const { requestId, jobId } = await batch(s, { normalizedStatus: 'partially_ready' });
      await createTrack(ctx.db, {
        ownerUserId: s.ownerUserId,
        generationRequestId: requestId,
        providerJobId: jobId,
        status: 'rejected',
        dislikedAt: NOW,
      });
      expect((await incoming(s.sessionId)).incomingTracks).toBe(1);
    });

    it('an older-revision job is left out while a switch-now is armed', async () => {
      const s = await session();
      await batch(s, { normalizedStatus: 'processing', styleRevision: 1 });
      await batch(s, { normalizedStatus: 'processing', styleRevision: 2 });
      expect((await incoming(s.sessionId)).incomingTracks).toBe(4);
      expect((await incoming(s.sessionId, 2)).incomingTracks).toBe(2);
    });

    it('a phantom submit stops counting at its cutoff', async () => {
      const young = await session();
      await batch(young, {
        normalizedStatus: 'submit_unknown',
        submitState: 'submit_unknown',
        updatedAt: NOW,
      });
      expect((await incoming(young.sessionId)).incomingTracks).toBe(2);

      const expired = await session();
      await batch(expired, {
        normalizedStatus: 'submit_unknown',
        submitState: 'submit_unknown',
        updatedAt: CUTOFF,
      });
      expect((await incoming(expired.sessionId)).incomingTracks).toBe(0);
    });
  });

  it('returns null provider-job state for a session that never generated', async () => {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    expect(await getLatestProviderJobState(ctx.db, sessionId)).toBeNull();
  });
});
