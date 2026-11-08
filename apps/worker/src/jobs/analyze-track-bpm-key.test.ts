import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_ANALYSIS_VERSION } from '@liedmotif/shared';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  rawTrackRow,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { insertGeneratedTrack, writeTrackAnalysis } from '@liedmotif/db';
import {
  targetAnchoredBpmAnalyzer,
  type TrackAnalysisOutcome,
  type TrackAudioAnalysisInput,
  type TrackAudioAnalyzer,
} from '@liedmotif/providers';
import { AnalysisResourceError } from '../audio/errors';
import { createAnalyzeTrackBpmKeyTask, runAnalyzeTrackBpmKey } from './analyze-track-bpm-key';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const MEASURED_OUTCOME: TrackAnalysisOutcome = {
  analysisStatus: 'measured',
  bpmEstimate: 128.4,
  bpmSource: 'measured',
  bpmConfidence: 0.88,
  integratedLufs: -12.7,
  truePeakDb: -1.3,
  headBeatAnchorSeconds: 0.4,
  headBeatPeriodSeconds: 60 / 128.4,
  tailBeatAnchorSeconds: 200.2,
  tailBeatPeriodSeconds: 60 / 128.3,
};

function analyzerReturning(outcome: TrackAnalysisOutcome): TrackAudioAnalyzer {
  return { analyze: async () => outcome };
}

/** Tests not about the embed re-enqueue drop it on the floor. */
const noopEmbed = async () => {};

describeIfDb('analyze-track-bpm-key job', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-analyze-job-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function seedTrack(
    opts: {
      status?: 'ready' | 'deleted';
      withAudio?: boolean;
      requestTargetBpm?: number | null;
      snapshotBpm?: number;
    } = {},
  ): Promise<string> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: {
        stylePrompt: 'instrumental',
        bpm: opts.snapshotBpm ?? 128,
        key: 'C major',
      },
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      targetBpm: opts.requestTargetBpm === undefined ? 128 : opts.requestTargetBpm,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const { id } = await insertGeneratedTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      providerKey: 'mock',
      providerTrackId: 'mock-task-x',
      prompt: 'instrumental',
      status: opts.status ?? 'ready',
      ...(opts.withAudio === false
        ? {}
        : { audio: { storageKey: 'audio/a.mp3', checksum: 'sum-a' } }),
    });
    return id;
  }

  it('persists a full measured outcome with current-version provenance', async () => {
    const trackId = await seedTrack();
    const result = await runAnalyzeTrackBpmKey(
      {
        db: ctx.db,
        analyzer: analyzerReturning(MEASURED_OUTCOME),
        enqueueEmbedMetadata: noopEmbed,
      },
      { trackId },
    );

    expect(result).toMatchObject({ analyzed: true, written: true, analysisStatus: 'measured' });
    const row = await rawTrackRow(ctx.db, trackId);
    expect(Number(row?.bpm_estimate)).toBeCloseTo(128.4);
    expect(row?.bpm_source).toBe('measured');
    expect(Number(row?.bpm_confidence)).toBeCloseTo(0.88);
    expect(Number(row?.lufs_integrated)).toBeCloseTo(-12.7);
    expect(Number(row?.true_peak_db)).toBeCloseTo(-1.3);
    expect(Number(row?.head_beat_anchor_seconds)).toBeCloseTo(0.4);
    expect(Number(row?.tail_beat_period_seconds)).toBeCloseTo(60 / 128.3);
    expect(row?.analysis_status).toBe('measured');
    expect(row?.analysis_version).toBe(CURRENT_ANALYSIS_VERSION);
    expect(row?.analysis_attempted_at).not.toBeNull();
  });

  it.each(['partial', 'unavailable', 'failed'] as const)(
    'persists a %s outcome with its provenance',
    async (status) => {
      const trackId = await seedTrack();
      const outcome: TrackAnalysisOutcome = {
        analysisStatus: status,
        bpmEstimate: status === 'failed' ? null : 127,
        bpmSource: status === 'failed' ? null : 'anchored',
        bpmConfidence: null,
        integratedLufs: status === 'partial' ? -13.5 : null,
        truePeakDb: status === 'partial' ? -1.9 : null,
        headBeatAnchorSeconds: null,
        headBeatPeriodSeconds: null,
        tailBeatAnchorSeconds: null,
        tailBeatPeriodSeconds: null,
      };
      await runAnalyzeTrackBpmKey(
        { db: ctx.db, analyzer: analyzerReturning(outcome), enqueueEmbedMetadata: noopEmbed },
        { trackId },
      );
      const row = await rawTrackRow(ctx.db, trackId);
      expect(row?.analysis_status).toBe(status);
      expect(row?.analysis_version).toBe(CURRENT_ANALYSIS_VERSION);
      if (status === 'partial') expect(Number(row?.lufs_integrated)).toBeCloseTo(-13.5);
    },
  );

  it("passes the track's OWN request target to the analyzer, never the live snapshot", async () => {
    // The request froze 92; the session snapshot has since moved to 160 (Change
    // Vibe). The analyzer must receive 92 — the track's own generation target.
    const trackId = await seedTrack({ requestTargetBpm: 92, snapshotBpm: 160 });
    const inputs: TrackAudioAnalysisInput[] = [];
    const spy: TrackAudioAnalyzer = {
      analyze: async (input) => {
        inputs.push(input);
        return targetAnchoredBpmAnalyzer().analyze(input);
      },
    };
    await runAnalyzeTrackBpmKey(
      { db: ctx.db, analyzer: spy, enqueueEmbedMetadata: noopEmbed },
      { trackId },
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.targetBpm).toBe(92);
    expect(inputs[0]!.audio.storageKey).toBe('audio/a.mp3');
  });

  it('legacy request without a target: analyzer receives null and anchored provenance lands', async () => {
    const trackId = await seedTrack({ requestTargetBpm: null, snapshotBpm: 160 });
    const result = await runAnalyzeTrackBpmKey(
      { db: ctx.db, analyzer: targetAnchoredBpmAnalyzer(), enqueueEmbedMetadata: noopEmbed },
      { trackId },
    );
    expect(result.analyzed).toBe(true);
    const row = await rawTrackRow(ctx.db, trackId);
    expect(row?.bpm_source).toBe('anchored');
    // The fallback anchor is the estimator's own default, NOT the live snapshot's 160.
    expect(Math.abs(Number(row?.bpm_estimate) - 110)).toBeLessThanOrEqual(2);
  });

  it('re-enqueues the metadata embed when a BPM lands (the MP3 was tagged before analysis)', async () => {
    const trackId = await seedTrack();
    const enqueued: string[] = [];
    await runAnalyzeTrackBpmKey(
      {
        db: ctx.db,
        analyzer: analyzerReturning(MEASURED_OUTCOME),
        enqueueEmbedMetadata: async (id) => {
          enqueued.push(id);
        },
      },
      { trackId },
    );
    expect(enqueued).toEqual([trackId]);
  });

  it('does not re-enqueue the embed when no BPM was written', async () => {
    const trackId = await seedTrack();
    const enqueued: string[] = [];
    const enqueueEmbedMetadata = async (id: string) => {
      enqueued.push(id);
    };
    // A failed outcome has no BPM — nothing new for the tags.
    await runAnalyzeTrackBpmKey(
      {
        db: ctx.db,
        analyzer: analyzerReturning({
          ...MEASURED_OUTCOME,
          analysisStatus: 'failed',
          bpmEstimate: null,
          bpmSource: null,
        }),
        enqueueEmbedMetadata,
      },
      { trackId },
    );
    // A CAS-declined write changed nothing either (the landed run enqueued).
    await writeTrackAnalysis(ctx.db, {
      trackId,
      bpmEstimate: 130,
      bpmSource: 'measured',
      analysisStatus: 'measured',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });
    await runAnalyzeTrackBpmKey(
      { db: ctx.db, analyzer: analyzerReturning(MEASURED_OUTCOME), enqueueEmbedMetadata },
      { trackId },
    );
    expect(enqueued).toEqual([]);
  });

  it('never writes musicalKey (measured key is deferred)', async () => {
    const trackId = await seedTrack();
    await runAnalyzeTrackBpmKey(
      {
        db: ctx.db,
        analyzer: analyzerReturning(MEASURED_OUTCOME),
        enqueueEmbedMetadata: noopEmbed,
      },
      { trackId },
    );
    const row = await rawTrackRow(ctx.db, trackId);
    expect(row?.musical_key).toBeNull();
  });

  it('CAS: reports written=false when a newer/equal analysis already landed', async () => {
    const trackId = await seedTrack();
    await writeTrackAnalysis(ctx.db, {
      trackId,
      bpmEstimate: 130,
      bpmSource: 'measured',
      analysisStatus: 'measured',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });

    const result = await runAnalyzeTrackBpmKey(
      {
        db: ctx.db,
        analyzer: analyzerReturning(MEASURED_OUTCOME),
        enqueueEmbedMetadata: noopEmbed,
      },
      { trackId },
    );
    expect(result.written).toBe(false);
    const row = await rawTrackRow(ctx.db, trackId);
    expect(Number(row?.bpm_estimate)).toBeCloseTo(130); // the earlier write survives
  });

  it('refuses an implausible outcome (range validation on every write)', async () => {
    const trackId = await seedTrack();
    await expect(
      runAnalyzeTrackBpmKey(
        {
          db: ctx.db,
          analyzer: analyzerReturning({ ...MEASURED_OUTCOME, bpmEstimate: 500 }),
          enqueueEmbedMetadata: noopEmbed,
        },
        { trackId },
      ),
    ).rejects.toThrow(/out of range/);
    const row = await rawTrackRow(ctx.db, trackId);
    expect(row?.analysis_status).toBe('pending'); // nothing was written
  });

  it('is a no-op for a deleted track (idempotent / never resurrects audio)', async () => {
    const trackId = await seedTrack({ status: 'deleted' });
    const result = await runAnalyzeTrackBpmKey(
      {
        db: ctx.db,
        analyzer: analyzerReturning(MEASURED_OUTCOME),
        enqueueEmbedMetadata: noopEmbed,
      },
      { trackId },
    );
    expect(result.analyzed).toBe(false);
  });

  it('skips when no downloaded audio is present yet', async () => {
    const trackId = await seedTrack({ withAudio: false });
    const result = await runAnalyzeTrackBpmKey(
      {
        db: ctx.db,
        analyzer: analyzerReturning(MEASURED_OUTCOME),
        enqueueEmbedMetadata: noopEmbed,
      },
      { trackId },
    );
    expect(result.analyzed).toBe(false);
  });

  it('resource shortage on the LAST attempt records unavailable and COMPLETES (key released)', async () => {
    // Temp disk full is a host condition, not an input defect: the terminal
    // provenance is `unavailable` (boot probe reopens it later), and the job
    // completes so the versioned job key is freed for the post-reopen enqueue.
    const trackId = await seedTrack();
    const outOfDisk: TrackAudioAnalyzer = {
      analyze: async () => {
        throw new AnalysisResourceError('not enough temp-disk headroom');
      },
    };
    const task = createAnalyzeTrackBpmKeyTask({ db: ctx.db, analyzer: outOfDisk });
    const warn = vi.fn();
    const helpers = (attempts: number) =>
      ({ job: { attempts, max_attempts: 3 }, logger: { warn } }) as never;

    // Attempt 1: rethrows so Graphile retries with backoff — with the failing
    // run's duration in the diagnostics.
    await expect(task({ trackId }, helpers(1))).rejects.toThrow(/headroom/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/attempt 1\/3 .* failed after \d+ ms/);
    // Attempt 3: swallows, records unavailable (duration logged too).
    await expect(task({ trackId }, helpers(3))).resolves.toBeUndefined();
    expect(warn.mock.calls[1]?.[0]).toMatch(/resources exhausted .* after \d+ ms/);
    const row = await rawTrackRow(ctx.db, trackId);
    expect(row?.analysis_status).toBe('unavailable');
  });

  it('a failed TERMINAL write completes the job (frees the key for the sweep) instead of wedging', async () => {
    // Last attempt + the provenance write itself fails (DB blip): rethrowing
    // would leave a permanently-failed keyed job over a still-pending row —
    // the sweep would re-select the track forever while unsafe_dedupe can
    // never re-enqueue it. The wrapper must log and COMPLETE instead.
    const throwing: TrackAudioAnalyzer = {
      analyze: async () => {
        throw new Error('boom');
      },
    };
    // A broken db makes both the run AND the terminal write fail.
    const task = createAnalyzeTrackBpmKeyTask({ db: {} as never, analyzer: throwing });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const helpers = { job: { attempts: 3, max_attempts: 3 }, logger } as never;

    await expect(task({ trackId: 'any' }, helpers)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('job wrapper records failed provenance on the LAST attempt of a transient error', async () => {
    const trackId = await seedTrack();
    const throwing: TrackAudioAnalyzer = {
      analyze: async () => {
        throw new Error('ffmpeg exited with 1');
      },
    };
    const task = createAnalyzeTrackBpmKeyTask({ db: ctx.db, analyzer: throwing });
    const warn = vi.fn();
    const helpersFor = (attempts: number, maxAttempts: number) =>
      ({ job: { attempts, max_attempts: maxAttempts }, logger: { warn } }) as never;

    // Attempt 1 of 3: rethrows, nothing recorded — Graphile will retry.
    await expect(task({ trackId }, helpersFor(1, 3))).rejects.toThrow(/ffmpeg/);
    expect((await rawTrackRow(ctx.db, trackId))?.analysis_status).toBe('pending');

    // Attempt 3 of 3: rethrows AND leaves failed provenance behind — with the
    // terminal run's duration in the diagnostics.
    await expect(task({ trackId }, helpersFor(3, 3))).rejects.toThrow(/ffmpeg/);
    expect(warn.mock.calls.at(-1)?.[0]).toMatch(/failed terminally .* after \d+ ms/);
    const row = await rawTrackRow(ctx.db, trackId);
    expect(row?.analysis_status).toBe('failed');
    expect(row?.analysis_version).toBe(CURRENT_ANALYSIS_VERSION);
  });

  it('logs the outcome status + duration into the worker diagnostics', async () => {
    const trackId = await seedTrack();
    const task = createAnalyzeTrackBpmKeyTask({
      db: ctx.db,
      analyzer: analyzerReturning(MEASURED_OUTCOME),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const addJob = vi.fn();
    const helpers = { job: { attempts: 1, max_attempts: 3 }, logger, addJob } as never;

    await task({ trackId }, helpers);
    expect(logger.info).toHaveBeenCalledOnce();
    // The landed BPM re-enqueues the embed through Graphile's addJob.
    expect(addJob).toHaveBeenCalledWith(
      'embed-track-metadata',
      { trackId },
      expect.objectContaining({ jobKey: `embed:${trackId}` }),
    );
    const message = logger.info.mock.calls[0]?.[0] as string;
    expect(message).toMatch(
      new RegExp(`analysis measured for track ${trackId} in \\d+ ms \\(written\\)`),
    );

    // A duplicate re-run CAS-noops — the log says so instead of claiming a write.
    await task({ trackId }, helpers);
    expect(logger.info.mock.calls[1]?.[0]).toMatch(/\(stale — a newer analysis already landed\)/);
  });
});
