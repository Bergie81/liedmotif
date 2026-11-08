// Provider-polling SLO under concurrent analysis: provider poll dispatch delay
// while analysis runs stays ≤ 5 s at p95. A REAL Graphile runner on the test
// database executes a real CPU-heavy analysis while poll-shaped jobs arrive;
// the poll jobs' dispatch delay (run_at → actual dispatch) must stay inside the
// SLO. This is the gate that keeps the estimator in a worker thread: run the
// same DSP synchronously on the main thread and poll dispatch stalls for the
// whole analysis.
//
// The analysis task prefers the FULL analyzer (staging + ffmpeg passes + the
// estimator thread) against a click-track WAV in mock storage; on a host
// without ffmpeg it falls back to the estimator thread alone — the CPU-heavy
// stage either way (ffmpeg itself is a separate process, inherently off-loop).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run, type Runner } from 'graphile-worker';
import { connectTestDb, TEST_DATABASE_URL, type TestDb } from '@liedmotif/db/testing';
import { createMockStorageProvider, type MockStorage } from '@liedmotif/storage';
import { clickTrack, pcmToWav } from './audio/analysis-fixtures';
import { runEstimatorInThread } from './audio/estimator-thread';
import { isFfmpegAvailable } from './audio/ffmpeg';
import { createWorkerTrackAnalyzer } from './audio/track-analyzer';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const POLL_DISPATCH_SLO_MS = 5_000;
/** Below this the ladder sampled the analysis too thinly to say anything about
 *  dispatch delay, whichever way the p95 happens to land. */
const MIN_IN_WINDOW_POLLS = 3;
/** Poll jobs are PRE-SCHEDULED at fixed future `run_at` times spanning far
 *  past the expected analysis duration. No live producer: a producer on the
 *  same event loop would freeze together with the stall it is supposed to
 *  expose, and delays are measured against `run_at`, so a poll that fell due
 *  DURING a stall surfaces the full stall in its delay. Spacing is sized for
 *  the SHORTEST analysis either host shape can draw — the estimator thread
 *  alone, no ffmpeg (CI's `test` job), ~1.5 s against ~7-9 s for the full
 *  analyzer — so the sample stays adequate on both. */
const POLL_SPACING_MS = 200;
const POLL_COUNT = 120; // 24 s span — comfortably past the analysis on CI too

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

describeIfDb('provider-polling SLO while analysis runs (same runner)', () => {
  let ctx: TestDb;
  let mock: MockStorage;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-analysis-slo-test');
    // A fresh graphile_worker schema per run: leftover jobs from older runs
    // would otherwise land in this runner with unknown task identifiers.
    await ctx.pool.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
    mock = createMockStorageProvider();
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
    await mock?.cleanup();
  });

  it('keeps poll dispatch delay ≤ 5 s p95 while a real analysis crunches', async () => {
    // ~9 minutes of clicks: seconds of estimator CPU — plenty of overlap window.
    const { pcm } = clickTrack(128, 540);
    const storageKey = 'tracks/slo/click.wav';
    await mock.provider.write({ key: storageKey, body: pcmToWav(pcm, 22050) });
    const ffmpegPresent = await isFfmpegAvailable();
    const analyzer = createWorkerTrackAnalyzer({ storage: mock.provider });

    const dispatched: Array<{ runAtMs: number; dispatchedAtMs: number }> = [];
    let analysisStartedAt = 0;
    let analysisEndedAt = 0;
    let analysisDone: (() => void) | undefined;
    const analysisFinished = new Promise<void>((resolve) => (analysisDone = resolve));

    let runner: Runner | undefined;
    try {
      runner = await run({
        pgPool: ctx.pool,
        // The production shape: low concurrency, the analysis in its own
        // serialized queue occupying ONE slot, polls dispatching on the other.
        concurrency: 2,
        pollInterval: 100,
        noHandleSignals: true,
        taskList: {
          'analyze-track-bpm-key': async () => {
            analysisStartedAt = Date.now();
            try {
              if (ffmpegPresent) {
                await analyzer.analyze({
                  audio: { storageKey, durationSeconds: 540 },
                  targetBpm: 128,
                });
              } else {
                await runEstimatorInThread(pcm, 128);
              }
            } finally {
              analysisEndedAt = Date.now();
              analysisDone?.();
            }
          },
          'poll-music-generation': async (_payload, helpers) => {
            dispatched.push({
              runAtMs: helpers.job.run_at.getTime(),
              dispatchedAtMs: Date.now(),
            });
          },
        },
      });

      // Lay the WHOLE ladder first, then start the analysis: the analysis
      // window is then covered end to end by rungs that were already sitting in
      // the queue when it began, so an in-window delay is dispatch latency and
      // nothing else. Rungs that fall due before the analysis starts drain
      // harmlessly — the SLO statistic below is computed ONLY over rungs inside
      // the actual analysis window, so they can never dilute it.
      const ladderStart = Date.now();
      for (let i = 0; i < POLL_COUNT; i++) {
        await runner.addJob(
          'poll-music-generation',
          { providerJobId: `slo-${i}` },
          { runAt: new Date(ladderStart + i * POLL_SPACING_MS) },
        );
      }
      await runner.addJob(
        'analyze-track-bpm-key',
        { trackId: 'slo-track' },
        { queueName: 'track-analysis' },
      );
      await analysisFinished;
      // Drain every rung due inside the analysis window — the SLO data.
      const inAnalysisWindow = (runAtMs: number) =>
        runAtMs >= analysisStartedAt && runAtMs <= analysisEndedAt;
      const expectedCount = Array.from(
        { length: POLL_COUNT },
        (_, i) => ladderStart + i * POLL_SPACING_MS,
      ).filter(inAnalysisWindow).length;
      const drainDeadline = Date.now() + 60_000;
      while (
        dispatched.filter((d) => inAnalysisWindow(d.runAtMs)).length < expectedCount &&
        Date.now() < drainDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await runner?.stop();
    }

    const inWindow = dispatched.filter(
      (d) => d.runAtMs >= analysisStartedAt && d.runAtMs <= analysisEndedAt,
    );
    const delays = inWindow.map((d) => d.dispatchedAtMs - d.runAtMs);
    // The measurement is only meaningful with several polls due DURING the
    // analysis (never before it started, never after it ended). A thin sample
    // is a statement about the ladder, not about dispatch — say which, because
    // the two host shapes crunch for very different lengths of time.
    expect(analysisEndedAt).toBeGreaterThan(analysisStartedAt);
    expect(
      inWindow.length,
      `only ${inWindow.length} poll rung(s) fell inside a ${analysisEndedAt - analysisStartedAt} ms ` +
        `analysis (${ffmpegPresent ? 'full analyzer' : 'estimator thread only, no ffmpeg'}) at ` +
        `${POLL_SPACING_MS} ms spacing: the ladder is too coarse for this path, which is not ` +
        `evidence either way about poll dispatch delay`,
    ).toBeGreaterThanOrEqual(MIN_IN_WINDOW_POLLS);
    expect(percentile(delays, 0.95)).toBeLessThanOrEqual(POLL_DISPATCH_SLO_MS);
  }, 120_000);
});
