import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  activitySessionQueueItems,
  activitySessions,
  generationRequests,
  getProviderJobForPoll,
  insertSubmittingGenerationJob,
  markGenerationRequestFailed,
  markProviderJobSubmitted,
  providerJobs,
  tracks,
  updateProviderJobPollState,
  withTransaction,
} from '@liedmotif/db';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import {
  mockMusicProvider,
  sunoMusicProvider,
  type MusicGenerationStatusResult,
  type MusicProvider,
} from '@liedmotif/providers';
import { sunoFixtures as fixtures } from '@liedmotif/providers/testing';
import {
  COLD_START_FAST_POLL_LIMIT,
  COLD_START_POLL_INTERVAL_MS,
  createPollMusicGenerationTask,
  DEFAULT_MAX_POLL_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
  runPollMusicGeneration,
} from './poll-music-generation';
import { runProcessProviderResults } from './process-provider-results';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const KEY = randomBytes(32);
const NOW = new Date('2026-06-30T12:00:00Z');

/** A music provider whose `getGenerationStatus` returns scripted normalized results. */
function scriptedProvider(
  script: (
    taskId: string,
    call: number,
  ) => MusicGenerationStatusResult | Promise<MusicGenerationStatusResult>,
): { provider: MusicProvider; calls: () => number } {
  const base = mockMusicProvider();
  let calls = 0;
  return {
    provider: {
      ...base,
      async getGenerationStatus(taskId) {
        calls += 1;
        return script(taskId, calls);
      },
    },
    calls: () => calls,
  };
}

const PROVIDER = { providerType: 'music' as const, providerKey: 'mock' };
function result(
  status: MusicGenerationStatusResult['status'],
  tracksOut: MusicGenerationStatusResult['tracks'],
  failureReason?: MusicGenerationStatusResult['failureReason'],
): MusicGenerationStatusResult {
  return {
    status,
    tracks: tracksOut,
    provider: PROVIDER,
    ...(failureReason ? { failureReason } : {}),
  };
}

describeIfDb('poll-music-generation', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-poll-music-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  /** A submitted music job ready to be polled (task id captured). */
  async function submittedJob(
    taskId: string | null = 'suno-task',
    session: { useStandardCover?: boolean } = {},
  ): Promise<{
    ownerUserId: string;
    sessionId: string;
    requestId: string;
    jobId: string;
  }> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId, ...session });
    const { requestId, jobId } = await withTransaction(ctx.db, (tx) =>
      insertSubmittingGenerationJob(tx, {
        ownerUserId,
        activitySessionId: sessionId,
        providerKey: 'mock',
        stylePrompt: 'instrumental lofi',
      }),
    );
    if (taskId) await markProviderJobSubmitted(ctx.db, { jobId, providerTaskId: taskId });
    return { ownerUserId, sessionId, requestId, jobId };
  }

  async function jobRow(jobId: string) {
    const [row] = await ctx.db
      .select({
        normalizedStatus: providerJobs.normalizedStatus,
        providerStatus: providerJobs.providerStatus,
        nextPollAt: providerJobs.nextPollAt,
        retryCount: providerJobs.retryCount,
      })
      .from(providerJobs)
      .where(eq(providerJobs.id, jobId));
    return row!;
  }

  function deps(
    provider: MusicProvider,
    overrides?: Partial<Parameters<typeof runPollMusicGeneration>[0]>,
  ) {
    return {
      db: ctx.db,
      music: provider,
      encryptionKey: KEY,
      now: NOW,
      reschedulePoll: vi.fn(async () => {}),
      enqueueDownload: vi.fn(async () => {}),
      enqueueBuffer: vi.fn(async () => {}),
      enqueueProcessResults: vi.fn(async () => {}),
      enqueueSessionCover: vi.fn(async () => {}),
      ...overrides,
    };
  }

  const FINAL_TRACKS = [
    {
      providerTrackId: 'A',
      title: 'A',
      streamAudioUrl: 'https://cdn.example/s/A',
      audioUrl: 'https://cdn.example/f/A.mp3',
      durationSeconds: 168,
    },
    {
      providerTrackId: 'B',
      title: 'B',
      streamAudioUrl: 'https://cdn.example/s/B',
      audioUrl: 'https://cdn.example/f/B.mp3',
      durationSeconds: 167,
    },
  ];

  it('on complete: persists ready, materializes both tracks, enqueues downloads, stops polling', async () => {
    const { jobId } = await submittedJob();
    const { provider } = scriptedProvider(() => result('complete', FINAL_TRACKS));
    const d = deps(provider);

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('advanced');
    expect(r.normalizedStatus).toBe('ready');

    const row = await jobRow(jobId);
    expect(row.normalizedStatus).toBe('ready');
    expect(row.providerStatus).toBe('complete');
    expect(row.nextPollAt).toBeNull();
    expect(row.providerStatus).not.toMatch(/https?:\/\//);

    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
    expect(d.enqueueDownload).toHaveBeenCalledTimes(2);
    expect(d.reschedulePoll).not.toHaveBeenCalled();
    // A styled session's cover never waits on music — no kick.
    expect(d.enqueueSessionCover).not.toHaveBeenCalled();
  });

  it('on complete: kicks the waiting cover job of a standard-cover session', async () => {
    const { ownerUserId, sessionId, jobId } = await submittedJob('suno-task', {
      useStandardCover: true,
    });
    const { provider } = scriptedProvider(() => result('complete', FINAL_TRACKS));
    const d = deps(provider);

    await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(d.enqueueSessionCover).toHaveBeenCalledWith({
      ownerUserId,
      activitySessionId: sessionId,
    });
  });

  it('does not kick the cover job while the standard-cover job is still in progress', async () => {
    const { jobId } = await submittedJob('suno-task', { useStandardCover: true });
    const streamOnly = [{ providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' }];
    const { provider } = scriptedProvider(() => result('text_ready', streamOnly));
    const d = deps(provider);

    await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(d.enqueueSessionCover).not.toHaveBeenCalled();
  });

  it('on text-ready (stream-only): persists processing, creates streamable tracks, reschedules, no downloads', async () => {
    const { jobId, sessionId } = await submittedJob();
    const streamOnly = [
      { providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' },
      { providerTrackId: 'B', streamAudioUrl: 'https://cdn.example/s/B' },
    ];
    const { provider } = scriptedProvider(() => result('text_ready', streamOnly));
    const d = deps(provider);

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('advanced');
    expect(await jobRow(jobId)).toMatchObject({
      normalizedStatus: 'processing',
      providerStatus: 'text_ready',
    });

    const rows = await ctx.db.select().from(tracks);
    expect(rows).toHaveLength(2);
    expect(rows.every((t) => t.status === 'streamable')).toBe(true);
    expect(d.enqueueDownload).not.toHaveBeenCalled();
    expect(d.reschedulePoll).toHaveBeenCalledTimes(1);
    // Streams exist but NO track is complete yet (no duration): the cold-start
    // cadence continues — the player is showing an unknown length until the
    // first completed track delivers one.
    const runAt = (d.reschedulePoll as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Date;
    expect(runAt.getTime() - NOW.getTime()).toBe(COLD_START_POLL_INTERVAL_MS);
    expect(sessionId).toBeTruthy();
  });

  it('on first-track-ready: persists partially_ready, enqueues one download, keeps polling', async () => {
    const { jobId } = await submittedJob();
    const partial = [
      {
        providerTrackId: 'A',
        streamAudioUrl: 'https://cdn.example/s/A',
        audioUrl: 'https://cdn.example/f/A.mp3',
        durationSeconds: 168,
      },
      { providerTrackId: 'B', streamAudioUrl: 'https://cdn.example/s/B' },
    ];
    const { provider } = scriptedProvider(() => result('first_track_ready', partial));
    const d = deps(provider);

    await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(await jobRow(jobId)).toMatchObject({ normalizedStatus: 'partially_ready' });
    expect(d.enqueueDownload).toHaveBeenCalledTimes(1);
    expect(d.reschedulePoll).toHaveBeenCalledTimes(1);
    // The first COMPLETE track (duration known) ends the cold start — polls
    // relax to the default cadence.
    const runAt = (d.reschedulePoll as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Date;
    expect(runAt.getTime() - NOW.getTime()).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('cold start (no complete track yet) polls on the fast cadence', async () => {
    // Until the first track COMPLETES the poll is what the cold-start UX
    // waits on: first the stream URL that lets playback begin,
    // then the duration that makes the progress bar real — catch each within
    // a few seconds.
    const { jobId } = await submittedJob();
    const { provider } = scriptedProvider(() => result('pending', []));
    const d = deps(provider);

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('advanced');
    const runAt = (d.reschedulePoll as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Date;
    expect(runAt.getTime() - NOW.getTime()).toBe(COLD_START_POLL_INTERVAL_MS);
  });

  it('the fast cadence is bounded: past the cold-start window even an incomplete job polls at the default interval', async () => {
    // A job stalled without a completed track must spend the rest of its
    // attempt budget at the default cadence, not burn it down 5s at a time.
    const { jobId } = await submittedJob();
    await ctx.db
      .update(providerJobs)
      .set({ retryCount: COLD_START_FAST_POLL_LIMIT })
      .where(eq(providerJobs.id, jobId));
    const { provider } = scriptedProvider(() => result('pending', []));
    const d = deps(provider);

    await runPollMusicGeneration(d, { providerJobId: jobId });
    const runAt = (d.reschedulePoll as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Date;
    expect(runAt.getTime() - NOW.getTime()).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('on insufficient-credit failure: blocks on credits, fails the request, refills buffer, stops', async () => {
    const { jobId, requestId, sessionId } = await submittedJob();
    const { provider } = scriptedProvider(() => result('failed', [], 'insufficient_credit'));
    const d = deps(provider);

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('failed');
    expect(await jobRow(jobId)).toMatchObject({
      normalizedStatus: 'blocked_by_provider_credits',
      providerStatus: 'failed',
      nextPollAt: null,
    });
    const [req] = await ctx.db
      .select({ status: generationRequests.status, errorCode: generationRequests.errorCode })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId));
    expect(req).toMatchObject({ status: 'failed', errorCode: 'insufficient_credit' });
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
    expect(d.enqueueBuffer).toHaveBeenCalledWith(sessionId);
    expect(d.reschedulePoll).not.toHaveBeenCalled();
  });

  // The superseded Session's batch can hold the owner's only concurrency slot
  // while the new Session's first fill waits: the job freeing it wakes the
  // owner's Active Session, not only its own stopped one.
  for (const [ending, providerResult] of [
    ['completes', result('complete', FINAL_TRACKS)],
    ['fails', result('failed', [], 'generation_failed')],
  ] as const) {
    it(`a superseded Session's job that ${ending} wakes the owner's Active Session`, async () => {
      const { ownerUserId, sessionId: supersededId, jobId } = await submittedJob();
      await ctx.db
        .update(activitySessions)
        .set({ status: 'stopped' })
        .where(eq(activitySessions.id, supersededId));
      const activeId = await createSession(ctx.db, { ownerUserId });
      const { provider } = scriptedProvider(() => providerResult);
      const d = deps(provider);

      await runPollMusicGeneration(d, { providerJobId: jobId });
      expect(d.enqueueBuffer).toHaveBeenCalledWith(activeId);
    });
  }

  it('maps a sensitive-content failure to a policy block (terminal)', async () => {
    const { jobId } = await submittedJob();
    const { provider } = scriptedProvider(() => result('failed', [], 'sensitive_content'));
    await runPollMusicGeneration(deps(provider), { providerJobId: jobId });
    expect(await jobRow(jobId)).toMatchObject({ normalizedStatus: 'blocked_by_policy' });
  });

  it('maps a generic generation failure to failed_final', async () => {
    const { jobId } = await submittedJob();
    const { provider } = scriptedProvider(() => result('failed', [], 'generation_failed'));
    await runPollMusicGeneration(deps(provider), { providerJobId: jobId });
    expect(await jobRow(jobId)).toMatchObject({ normalizedStatus: 'failed_final' });
  });

  it('a provider failure after the stream stage fails the job’s Tracks that have no final', async () => {
    const { jobId } = await submittedJob();
    const partial = [
      {
        providerTrackId: 'A',
        streamAudioUrl: 'https://cdn.example/s/A',
        audioUrl: 'https://cdn.example/f/A.mp3',
        durationSeconds: 168,
      },
      { providerTrackId: 'B', streamAudioUrl: 'https://cdn.example/s/B' },
    ];
    const { provider } = scriptedProvider((_task, call) =>
      call === 1 ? result('first_track_ready', partial) : result('failed', [], 'generation_failed'),
    );
    const d = deps(provider);

    await runPollMusicGeneration(d, { providerJobId: jobId });
    const r = await runPollMusicGeneration(d, { providerJobId: jobId });

    expect(r.outcome).toBe('failed');
    const rows = await ctx.db
      .select({
        providerTrackId: tracks.providerTrackId,
        status: tracks.status,
        slotState: activitySessionQueueItems.state,
      })
      .from(tracks)
      .innerJoin(activitySessionQueueItems, eq(activitySessionQueueItems.trackId, tracks.id))
      .orderBy(tracks.providerTrackId);
    expect(rows).toEqual([
      { providerTrackId: 'A', status: 'streamable', slotState: 'queued' },
      { providerTrackId: 'B', status: 'failed', slotState: 'failed' },
    ]);
  });

  it('a job that timed out while polling keeps its stream-only Tracks live', async () => {
    const { jobId } = await submittedJob();
    const streamOnly = [{ providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' }];
    const { provider } = scriptedProvider(() => result('text_ready', streamOnly));

    await runPollMusicGeneration(deps(provider, { maxPollAttempts: 1 }), { providerJobId: jobId });

    const rows = await ctx.db.select({ status: tracks.status }).from(tracks);
    expect(rows).toEqual([{ status: 'streamable' }]);
  });

  it('is idempotent: re-polling a terminal (ready) job never calls the provider again', async () => {
    const { jobId } = await submittedJob();
    const completed = scriptedProvider(() => result('complete', FINAL_TRACKS));
    await runPollMusicGeneration(deps(completed.provider), { providerJobId: jobId });
    expect(completed.calls()).toBe(1);
    expect(await ctx.db.select().from(tracks)).toHaveLength(2);

    // A second poll of the now-ready job is a no-op: the provider is not called and
    // no second track row is created. It only hands the job to the (idempotent)
    // materialization recovery, in case the first attempt crashed mid-materialize.
    const guard = scriptedProvider(() => {
      throw new Error('provider must not be polled after terminal');
    });
    const d = deps(guard.provider);
    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('already_terminal');
    expect(guard.calls()).toBe(0);
    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
    expect(d.enqueueProcessResults).toHaveBeenCalledWith(jobId);
  });

  it('a job CAS’d ready whose materialization crashed self-heals via process-provider-results', async () => {
    const { jobId } = await submittedJob();
    // Stage the crash window: the poll's terminal CAS landed (`ready`) but the worker
    // died before `runProcessProviderResults` — a paid job with zero tracks.
    await updateProviderJobPollState(ctx.db, {
      jobId,
      providerStatus: 'complete',
      normalizedStatus: 'ready',
      nextPollAt: null,
      retryCount: 1,
    });
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);

    // The Graphile retry of the crashed poll finds the job terminal and enqueues the
    // recovery task instead of abandoning the tracks.
    const guard = scriptedProvider(() => {
      throw new Error('the retried poll itself must not re-poll the provider');
    });
    const d = deps(guard.provider);
    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('already_terminal');
    expect(d.enqueueProcessResults).toHaveBeenCalledTimes(1);
    expect(d.enqueueProcessResults).toHaveBeenCalledWith(jobId);

    // The recovery task re-reads status server-side and materializes the paid tracks.
    const { provider } = scriptedProvider(() => result('complete', FINAL_TRACKS));
    const job = await getProviderJobForPoll(ctx.db, jobId);
    const status = await provider.getGenerationStatus(job!.providerTaskId!);
    const processed = await runProcessProviderResults(
      {
        db: ctx.db,
        encryptionKey: KEY,
        enqueueDownload: vi.fn(async () => {}),
        enqueueBuffer: vi.fn(async () => {}),
      },
      { job: job!, tracks: status.tracks },
    );
    expect(processed.processedTrackIds).toHaveLength(2);
    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
  });

  it('a re-poll of a non-ready terminal job does NOT enqueue the recovery', async () => {
    const { jobId } = await submittedJob();
    const { provider } = scriptedProvider(() => result('failed', [], 'generation_failed'));
    await runPollMusicGeneration(deps(provider), { providerJobId: jobId });

    const guard = scriptedProvider(() => {
      throw new Error('provider must not be polled after terminal');
    });
    const d = deps(guard.provider);
    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('already_terminal');
    expect(d.enqueueProcessResults).not.toHaveBeenCalled();
  });

  it('two non-terminal polls of the same job materialize exactly one track row each', async () => {
    const { jobId } = await submittedJob();
    const { provider } = scriptedProvider(() => result('first_track_ready', FINAL_TRACKS));
    const d = deps(provider);
    await runPollMusicGeneration(d, { providerJobId: jobId });
    await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
  });

  it('skips materialization when a poll observed nothing new (status and URLs unchanged)', async () => {
    const { jobId } = await submittedJob();
    const streamOnly = [
      { providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' },
      { providerTrackId: 'B', streamAudioUrl: 'https://cdn.example/s/B' },
    ];
    const { provider } = scriptedProvider(() => result('text_ready', streamOnly));
    const d = deps(provider);

    const first = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(first.processedTrackIds).toHaveLength(2);
    expect(d.enqueueBuffer).toHaveBeenCalledTimes(1);

    // Same provider status, same URLs: the repeat poll records its attempt but
    // runs no materialization (no upserts, no cutover, no buffer enqueue).
    const second = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(second.outcome).toBe('advanced');
    expect(second.processedTrackIds).toEqual([]);
    expect(d.enqueueBuffer).toHaveBeenCalledTimes(1);
    expect((await jobRow(jobId)).retryCount).toBe(2);
    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
  });

  it('still materializes when a new stream URL appears under an unchanged provider status', async () => {
    const { jobId } = await submittedJob();
    const byCall = [
      [{ providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' }],
      [
        { providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' },
        { providerTrackId: 'B', streamAudioUrl: 'https://cdn.example/s/B' },
      ],
    ];
    const { provider } = scriptedProvider((_taskId, call) =>
      result('text_ready', byCall[Math.min(call, 2) - 1]!),
    );
    const d = deps(provider);

    await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(await ctx.db.select().from(tracks)).toHaveLength(1);

    // The provider status token is still `text_ready`, but sibling B's stream is
    // new — the poll must materialize it, not skip as a no-op.
    await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(await ctx.db.select().from(tracks)).toHaveLength(2);
    expect(d.enqueueBuffer).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for a job with no captured task id, or a missing job id', async () => {
    const { jobId } = await submittedJob(null); // submit_unknown-style: no task id
    const guard = scriptedProvider(() => {
      throw new Error('must not poll without a task id');
    });
    expect(
      (await runPollMusicGeneration(deps(guard.provider), { providerJobId: jobId })).outcome,
    ).toBe('no_task_id');
    expect(
      (
        await runPollMusicGeneration(deps(guard.provider), {
          providerJobId: '00000000-0000-0000-0000-000000000000',
        })
      ).outcome,
    ).toBe('missing');
    expect(guard.calls()).toBe(0);
  });

  it('closes a vanished owner’s job without polling: the request survives as spend ledger, the job frees its slot', async () => {
    const { jobId, requestId } = await submittedJob();
    // Member delete: the set-null FK leaves the request ownerless.
    await ctx.db
      .update(generationRequests)
      .set({ ownerUserId: null })
      .where(eq(generationRequests.id, requestId));

    const guard = scriptedProvider(() => {
      throw new Error('must not poll a job whose owner is gone');
    });
    const poll = await runPollMusicGeneration(deps(guard.provider), { providerJobId: jobId });
    expect(poll.outcome).toBe('missing');
    expect(guard.calls()).toBe(0);
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
    // A live status would hold a Members Pool concurrency slot forever.
    expect(await jobRow(jobId)).toMatchObject({
      normalizedStatus: 'failed_final',
      nextPollAt: null,
    });
  });

  it('logs one secret-free observation line per poll: status + field presence, never URLs', async () => {
    const { jobId } = await submittedJob();
    // One playable stream track, one text-stage sibling with no URLs yet.
    const midFlight = [
      { providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' },
      { providerTrackId: 'B', title: 'B' },
    ];
    const { provider } = scriptedProvider(() => result('text_ready', midFlight));
    const info = vi.fn();

    await runPollMusicGeneration(deps(provider, { info }), { providerJobId: jobId });

    expect(info).toHaveBeenCalledTimes(1);
    const [message, fields] = info.mock.calls[0]!;
    expect(message).toBe('music poll observed');
    expect(fields).toMatchObject({
      providerJobId: jobId,
      attempt: 1,
      providerStatus: 'text_ready',
      trackCount: 2,
      withStream: 1,
      withFinal: 0,
      withDuration: 0,
    });
    expect(JSON.stringify(fields)).not.toMatch(/https?:\/\//);
  });

  it('logs a transport-error line so silent poll gaps stay visible', async () => {
    const { jobId } = await submittedJob();
    const { provider } = scriptedProvider(async () => {
      throw new Error('network blip');
    });
    const info = vi.fn();

    await runPollMusicGeneration(deps(provider, { info }), { providerJobId: jobId });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'music poll transport error',
      expect.objectContaining({ providerJobId: jobId, attempt: 1, willRetry: true }),
    );
  });

  it('on a transient transport error: reschedules without blocking the session or failing the request', async () => {
    const { jobId, requestId } = await submittedJob();
    const { provider } = scriptedProvider(async () => {
      throw new Error('network blip');
    });
    const d = deps(provider);

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('transport_error');
    // Status is unchanged (still in-flight) — never demoted to a block on a blip.
    expect(await jobRow(jobId)).toMatchObject({ normalizedStatus: 'submitted', retryCount: 1 });
    const [req] = await ctx.db
      .select({ status: generationRequests.status })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId));
    expect(req!.status).not.toBe('failed');
    expect(d.reschedulePoll).toHaveBeenCalledTimes(1);
  });

  // A key removed or undecryptable mid-flight must not leave the job live past
  // Graphile's own retries: only a counted attempt reaches the cap that ends it.
  it('counts a poll whose music provider cannot be built as an attempt, so the cap still ends the job', async () => {
    const { jobId } = await submittedJob();
    const addJob = vi.fn(async () => ({}) as never);
    const task = createPollMusicGenerationTask({
      db: ctx.db,
      encryptionKey: KEY,
      getMusic: async () => {
        throw new Error('No music provider key is configured.');
      },
    });
    const helpers = { addJob, logger: { info: () => {} } } as unknown as Parameters<typeof task>[1];

    await task({ providerJobId: jobId }, helpers);
    expect(await jobRow(jobId)).toMatchObject({ normalizedStatus: 'submitted', retryCount: 1 });
    expect(addJob).toHaveBeenCalledWith(
      'poll-music-generation',
      { providerJobId: jobId },
      expect.objectContaining({ jobKey: `poll:${jobId}` }),
    );

    await ctx.db
      .update(providerJobs)
      .set({ retryCount: DEFAULT_MAX_POLL_ATTEMPTS - 1 })
      .where(eq(providerJobs.id, jobId));
    await task({ providerJobId: jobId }, helpers);
    expect(await jobRow(jobId)).toMatchObject({
      normalizedStatus: 'failed_final',
      nextPollAt: null,
    });
  });

  it('BLOCKING 4 — terminalizes a still-non-terminal job that hits the attempt cap', async () => {
    const { jobId, requestId, sessionId } = await submittedJob();
    // A still-processing result at the cap must NOT be left non-terminal with no next
    // poll (which the safety-net would never rescue) — it ends as a timeout.
    const { provider } = scriptedProvider(() => result('text_ready', []));
    const d = deps(provider, { maxPollAttempts: 1 });

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('timed_out');

    const row = await jobRow(jobId);
    expect(row).toMatchObject({ normalizedStatus: 'failed_final', nextPollAt: null });
    const [req] = await ctx.db
      .select({ status: generationRequests.status, errorCode: generationRequests.errorCode })
      .from(generationRequests)
      .where(eq(generationRequests.id, requestId));
    expect(req).toMatchObject({ status: 'failed', errorCode: 'generation_timeout' });
    expect(d.enqueueBuffer).toHaveBeenCalledWith(sessionId);
    expect(d.reschedulePoll).not.toHaveBeenCalled();
  });

  // The timeout leaves the in-flight count before its Tracks exist; a refill
  // woken in between would see the batch's supply gone and buy another.
  it('a timed-out poll keeps the Tracks it saw before it wakes the buffer', async () => {
    const { jobId } = await submittedJob();
    const streamOnly = [
      { providerTrackId: 'A', streamAudioUrl: 'https://cdn.example/s/A' },
      { providerTrackId: 'B', streamAudioUrl: 'https://cdn.example/s/B' },
    ];
    const { provider } = scriptedProvider(() => result('text_ready', streamOnly));
    const tracksAtWake: number[] = [];
    const d = deps(provider, {
      maxPollAttempts: 1,
      enqueueBuffer: vi.fn(async () => {
        tracksAtWake.push((await ctx.db.select().from(tracks)).length);
      }),
    });

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });

    expect(r.outcome).toBe('timed_out');
    expect(tracksAtWake.length).toBeGreaterThan(0);
    expect(tracksAtWake.every((count) => count === 2)).toBe(true);
  });

  it('BLOCKING 1 — a stale overlapping poll cannot resurrect a job another poll drove terminal', async () => {
    const { jobId, requestId } = await submittedJob();
    // Poll B loads the job as `submitted` (non-terminal) and passes the early-return.
    // Then, mid-flight (inside the provider call), poll A drives the job terminal —
    // exactly the overlap window. B then sees `complete` with its STALE snapshot and
    // tries to write `ready` + materialize tracks. The CAS must reject it.
    const { provider } = scriptedProvider(async () => {
      await updateProviderJobPollState(ctx.db, {
        jobId,
        providerStatus: 'failed',
        normalizedStatus: 'failed_final',
        nextPollAt: null,
        retryCount: 99,
      });
      await markGenerationRequestFailed(ctx.db, {
        generationRequestId: requestId,
        errorCode: 'generation_failed',
        errorMessageSafe: 'failed by concurrent poll A',
      });
      return result('complete', FINAL_TRACKS);
    });
    const d = deps(provider);

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('superseded');

    // No resurrection: the job stays failed_final and NO tracks were materialized after
    // the terminal failure; no buffer/download was enqueued by the losing poll.
    expect(await jobRow(jobId)).toMatchObject({ normalizedStatus: 'failed_final' });
    expect(await ctx.db.select().from(tracks)).toHaveLength(0);
    expect(d.enqueueDownload).not.toHaveBeenCalled();
    expect(d.enqueueBuffer).not.toHaveBeenCalled();
    expect(d.reschedulePoll).not.toHaveBeenCalled();
  });

  it('runs the real Suno adapter against captured fixtures (zero network) end-to-end', async () => {
    const { jobId } = await submittedJob('9137870119d47296c238423547783e15');
    // Inject a fetch stub returning the SUCCESS record-info fixture — no real call.
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify(fixtures.recordInfoSuccess), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const provider = sunoMusicProvider({
      apiKey: 'test-key',
      fetch: fetchStub as unknown as typeof fetch,
    });
    const d = deps(provider);

    const r = await runPollMusicGeneration(d, { providerJobId: jobId });
    expect(r.outcome).toBe('advanced');
    expect(await jobRow(jobId)).toMatchObject({
      normalizedStatus: 'ready',
      providerStatus: 'complete',
    });
    const rows = await ctx.db.select().from(tracks);
    expect(rows).toHaveLength(2);
    expect(rows.every((t) => t.title === 'Paper Notes')).toBe(true);
    expect(d.enqueueDownload).toHaveBeenCalledTimes(2);
    // The fetch stub was the only network surface, and it never touched a real host.
    expect(fetchStub).toHaveBeenCalled();
  });
});
