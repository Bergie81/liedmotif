// Backfill + reanalysis: the recurring sweep
// enqueues analysis for ready finals without a current-version analysis, rate-
// limited; the worker boot probe re-opens `unavailable` rows once ffmpeg
// appears (and does nothing while it is still missing).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { runAnalysisBootProbe } from '../audio/boot-probe';
import { formatAnalysisStatusCounts, runBackfillTrackAnalysis } from './backfill-track-analysis';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('backfill-track-analysis + boot-probe reanalysis', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-backfill-analysis-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function seedReadyTrack(suffix: string, targetDurationMinutes?: number): Promise<string> {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, {
      ownerUserId,
      styleSnapshot: { stylePrompt: 'instrumental', bpm: 120, key: 'C major' },
      targetDurationMinutes,
    });
    const requestId = await createGenerationRequest(ctx.db, {
      ownerUserId,
      activitySessionId: sessionId,
      targetBpm: 120,
    });
    const jobId = await createProviderJob(ctx.db, { generationRequestId: requestId });
    const { id } = await insertGeneratedTrack(ctx.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId: jobId,
      providerKey: 'mock',
      providerTrackId: `mock-task-${suffix}`,
      prompt: 'instrumental',
      audio: { storageKey: `audio/${suffix}.mp3`, checksum: `sum-${suffix}` },
    });
    return id;
  }

  it('enqueues pending ready finals, bounded by the batch size', async () => {
    const a = await seedReadyTrack('bf-a');
    const b = await seedReadyTrack('bf-b');
    const enqueued: string[] = [];

    const result = await runBackfillTrackAnalysis({
      db: ctx.db,
      enqueueAnalyze: async (id) => {
        enqueued.push(id);
      },
      batchSize: 1,
    });
    expect(result.enqueued).toHaveLength(1);
    expect(enqueued).toHaveLength(1);

    const full = await runBackfillTrackAnalysis({
      db: ctx.db,
      enqueueAnalyze: async () => {},
    });
    expect(full.enqueued).toEqual(expect.arrayContaining([a, b]));
  });

  it('does not re-enqueue tracks already analyzed at the current version', async () => {
    const done = await seedReadyTrack('bf-done');
    await writeTrackAnalysis(ctx.db, {
      trackId: done,
      bpmEstimate: 120,
      bpmSource: 'measured',
      analysisStatus: 'measured',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });
    const result = await runBackfillTrackAnalysis({ db: ctx.db, enqueueAnalyze: async () => {} });
    expect(result.enqueued).not.toContain(done);
  });

  it('retries missing duration independently of completed BPM analysis', async () => {
    const done = await seedReadyTrack('duration-recovery', 20);
    await writeTrackAnalysis(ctx.db, {
      trackId: done,
      bpmEstimate: 120,
      bpmSource: 'measured',
      analysisStatus: 'measured',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });
    const enqueued: string[] = [];
    const deps = {
      db: ctx.db,
      enqueueAnalyze: async (id: string) => {
        enqueued.push(id);
      },
    };
    const warnings: unknown[] = [];
    await runBackfillTrackAnalysis({
      ...deps,
      measureDuration: async () => {
        throw new Error('Temporary audio read failure');
      },
      warn: (message, fields) => warnings.push({ message, trackId: fields?.trackId }),
    });
    expect((await rawTrackRow(ctx.db, done))?.duration_seconds).toBeNull();
    expect(warnings).toEqual([
      { message: expect.stringMatching(/duration measurement failed/), trackId: done },
    ]);

    const measured: string[] = [];
    await runBackfillTrackAnalysis({
      ...deps,
      measureDuration: async (key: string) => {
        measured.push(key);
        return 120;
      },
    });
    expect(measured).toEqual(['audio/duration-recovery.mp3']);
    expect((await rawTrackRow(ctx.db, done))?.duration_seconds).toBe(120);
    expect(enqueued).toEqual([]);
    expect((await rawTrackRow(ctx.db, done))?.analysis_status).toBe('measured');
  });

  it('boot probe without ffmpeg: nothing reset, unavailable rows stay parked', async () => {
    const parked = await seedReadyTrack('bp-parked');
    await writeTrackAnalysis(ctx.db, {
      trackId: parked,
      analysisStatus: 'unavailable',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });

    const probe = await runAnalysisBootProbe(ctx.db, { probe: async () => false });
    expect(probe).toEqual({ ffmpegAvailable: false, resetTrackIds: [] });
    expect((await rawTrackRow(ctx.db, parked))?.analysis_status).toBe('unavailable');
    // ...and the sweep must NOT pick it up (the non-reselection rule).
    const swept = await runBackfillTrackAnalysis({ db: ctx.db, enqueueAnalyze: async () => {} });
    expect(swept.enqueued).not.toContain(parked);
  });

  it('boot probe WITH ffmpeg: unavailable rows re-open and the next sweep enqueues them', async () => {
    const parked = await seedReadyTrack('bp-reopen');
    await writeTrackAnalysis(ctx.db, {
      trackId: parked,
      analysisStatus: 'unavailable',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });

    const probe = await runAnalysisBootProbe(ctx.db, { probe: async () => true });
    expect(probe.ffmpegAvailable).toBe(true);
    expect(probe.resetTrackIds).toEqual([parked]);

    const swept = await runBackfillTrackAnalysis({ db: ctx.db, enqueueAnalyze: async () => {} });
    expect(swept.enqueued).toContain(parked);
  });

  it('reports the analysis-status counts with each sweep tick', async () => {
    await seedReadyTrack('bf-counts-pending');
    const measured = await seedReadyTrack('bf-counts-measured');
    await writeTrackAnalysis(ctx.db, {
      trackId: measured,
      bpmEstimate: 120,
      bpmSource: 'measured',
      analysisStatus: 'measured',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });

    const result = await runBackfillTrackAnalysis({ db: ctx.db, enqueueAnalyze: async () => {} });
    expect(result.statusCounts).toEqual({
      pending: 1,
      measured: 1,
      partial: 0,
      unavailable: 0,
      failed: 0,
    });
    // The one-line summary the sweep logs into the worker diagnostics.
    expect(formatAnalysisStatusCounts(result.statusCounts!)).toBe(
      'track analysis status: pending=1 measured=1 partial=0 unavailable=0 failed=0',
    );
  });

  it('skips the status-count aggregate on an idle tick (nothing enqueued)', async () => {
    const measured = await seedReadyTrack('bf-idle-measured');
    await writeTrackAnalysis(ctx.db, {
      trackId: measured,
      bpmEstimate: 120,
      bpmSource: 'measured',
      analysisStatus: 'measured',
      analysisVersion: CURRENT_ANALYSIS_VERSION,
      analysisAttemptedAt: new Date(),
    });

    const result = await runBackfillTrackAnalysis({ db: ctx.db, enqueueAnalyze: async () => {} });
    expect(result.enqueued).toEqual([]);
    // An idle instance pays no full-table GROUP BY just for a log line.
    expect(result.statusCounts).toBeNull();
  });
});
