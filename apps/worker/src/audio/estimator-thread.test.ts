// The worker-thread spawn path for the tempo estimator, including the
// event-loop isolation requirement: the DSP must not stall the main thread the
// provider poll loop runs on. This is the estimator-level gate.

import { describe, expect, it } from 'vitest';
import { clickTrack } from './analysis-fixtures';
import { estimateAnchoredTempo } from './estimator';
import { runEstimatorInThread } from './estimator-thread';

describe('runEstimatorInThread', () => {
  it('produces the same estimate as the in-process estimator', async () => {
    // Two independent fixtures: the thread call TRANSFERS its PCM buffer, so
    // the direct run needs its own copy of the identical signal.
    const direct = estimateAnchoredTempo(clickTrack(120, 60).pcm, 120);
    const threaded = await runEstimatorInThread(clickTrack(120, 60).pcm, 120);
    expect(threaded.bpm).toBeCloseTo(direct.bpm, 6);
    expect(threaded.confidence).toBeCloseTo(direct.confidence, 6);
    expect(threaded.head?.anchorSeconds).toBeCloseTo(direct.head!.anchorSeconds, 6);
    expect(threaded.tail?.periodSeconds).toBeCloseTo(direct.tail!.periodSeconds, 6);
  }, 30_000);

  it('transfers the PCM buffer into the thread instead of cloning it', async () => {
    const { pcm } = clickTrack(120, 30);
    await runEstimatorInThread(pcm, 120);
    // The caller's view detaches on transfer — no second full PCM copy lives
    // across the DSP. Callers hand the array over and never touch it again.
    expect(pcm.length).toBe(0);
  }, 30_000);

  it('rejects and terminates the thread on timeout', async () => {
    const { pcm } = clickTrack(120, 180);
    await expect(runEstimatorInThread(pcm, 120, { timeoutMs: 1 })).rejects.toThrow(/timed out/);
  }, 30_000);

  it('keeps the main event loop responsive while a long analysis runs (isolation)', async () => {
    // A ~9-minute track is near the duration guard — long enough that running the
    // DSP synchronously would stall the loop for seconds. With the thread, the
    // main loop's worst observed stall must stay far below the 5 s polling SLO.
    const { pcm } = clickTrack(128, 540);
    let maxStallMs = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      maxStallMs = Math.max(maxStallMs, now - last - 25);
      last = now;
    }, 25);
    try {
      await runEstimatorInThread(pcm, 128);
    } finally {
      // Sample the FINAL gap before killing the ticker: if the call above ever
      // regressed to synchronous DSP, its whole block shows up here — the
      // microtask continuation would otherwise clear the overdue timer before
      // its callback could record the stall.
      maxStallMs = Math.max(maxStallMs, performance.now() - last - 25);
      clearInterval(ticker);
    }
    expect(maxStallMs).toBeLessThan(500);
  }, 60_000);
});
