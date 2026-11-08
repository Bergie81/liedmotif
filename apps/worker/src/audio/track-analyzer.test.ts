// The real analyzer's provenance decision table (stubbed stages), plus one
// end-to-end run against real ffmpeg on hosts that have it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { anchoredBpmEstimate } from '@liedmotif/providers';
import { createMockStorageProvider, type MockStorage } from '@liedmotif/storage';
import { clickTrack, pcmToWav } from './analysis-fixtures';
import type { AnchoredTempoEstimate } from './estimator';
import { AnalysisInputError } from './errors';
import { isFfmpegAvailable } from './ffmpeg';
import { createWorkerTrackAnalyzer, MAX_ANALYSIS_INPUT_SECONDS } from './track-analyzer';

const AUDIO = { storageKey: 'tracks/u/t.mp3', checksum: 'sum-1', durationSeconds: 200 };

const GOOD_TEMPO: AnchoredTempoEstimate = {
  bpm: 128.2,
  confidence: 0.91,
  autocorrelationPeak: 0.72,
  head: {
    anchorSeconds: 0.35,
    periodSeconds: 60 / 128.2,
    matchedFraction: 1,
    contrast: 8,
    residualFrames: 0.2,
  },
  tail: {
    anchorSeconds: 180.1,
    periodSeconds: 60 / 128.1,
    matchedFraction: 1,
    contrast: 8,
    residualFrames: 0.2,
  },
};

interface StubOverrides {
  probe?: () => Promise<boolean>;
  stage?: () => Promise<{ path: string; cleanup: () => Promise<void> }>;
  measure?: () => Promise<{ integratedLufs: number; truePeakDb: number }>;
  decode?: () => Promise<Float32Array>;
  estimate?: () => Promise<AnchoredTempoEstimate>;
}

function stubbedAnalyzer(overrides: StubOverrides = {}) {
  const cleanup = vi.fn(async () => {});
  const estimate = vi.fn(overrides.estimate ?? (async () => GOOD_TEMPO));
  const analyzer = createWorkerTrackAnalyzer({
    storage: {} as never,
    probeFfmpeg: overrides.probe ?? (async () => true),
    stage: overrides.stage
      ? ((async () => overrides.stage!()) as never)
      : ((async () => ({ path: '/tmp/staged', cleanup })) as never),
    measure: (overrides.measure ??
      (async () => ({ integratedLufs: -12.9, truePeakDb: -1.2 }))) as never,
    decode: (overrides.decode ?? (async () => new Float32Array(1024))) as never,
    estimate: estimate as never,
  });
  return { analyzer, cleanup, estimate };
}

afterEach(() => vi.restoreAllMocks());

describe('createWorkerTrackAnalyzer — provenance decision table', () => {
  it('no ffmpeg → unavailable with the anchored estimate (boot probe re-enqueues later)', async () => {
    const { analyzer, estimate } = stubbedAnalyzer({ probe: async () => false });
    const outcome = await analyzer.analyze({ audio: AUDIO, targetBpm: 128 });
    expect(outcome.analysisStatus).toBe('unavailable');
    expect(outcome.bpmSource).toBe('anchored');
    expect(outcome.bpmEstimate).toBe(
      anchoredBpmEstimate({ audio: AUDIO, targetBpm: 128 }).bpmEstimate,
    );
    expect(outcome.integratedLufs).toBeNull();
    expect(estimate).not.toHaveBeenCalled();
  });

  it('confidence ≥ floor with plausible grids → measured with all fields', async () => {
    const { analyzer, cleanup } = stubbedAnalyzer();
    const outcome = await analyzer.analyze({ audio: AUDIO, targetBpm: 128 });
    expect(outcome.analysisStatus).toBe('measured');
    expect(outcome.bpmSource).toBe('measured');
    expect(outcome.bpmEstimate).toBeCloseTo(128.2, 5);
    expect(outcome.bpmConfidence).toBeCloseTo(0.91, 5);
    expect(outcome.integratedLufs).toBeCloseTo(-12.9, 5);
    expect(outcome.truePeakDb).toBeCloseTo(-1.2, 5);
    expect(outcome.headBeatAnchorSeconds).toBeCloseTo(0.35, 5);
    expect(outcome.tailBeatPeriodSeconds).toBeCloseTo(60 / 128.1, 5);
    expect(cleanup).toHaveBeenCalled();
  });

  it('confidence below the floor → partial: LUFS kept, anchored BPM, no grids', async () => {
    const { analyzer } = stubbedAnalyzer({
      estimate: async () => ({ ...GOOD_TEMPO, confidence: 0.4 }),
    });
    const outcome = await analyzer.analyze({ audio: AUDIO, targetBpm: 128 });
    expect(outcome.analysisStatus).toBe('partial');
    expect(outcome.bpmSource).toBe('anchored');
    expect(outcome.integratedLufs).toBeCloseTo(-12.9, 5);
    expect(outcome.headBeatAnchorSeconds).toBeNull();
    expect(outcome.tailBeatPeriodSeconds).toBeNull();
  });

  it('a fitted grid the write bounds would reject → partial, not a write crash', async () => {
    const { analyzer } = stubbedAnalyzer({
      estimate: async () => ({
        ...GOOD_TEMPO,
        // Period 12% off the target beat period: outside the ±10% write bounds.
        tail: { ...GOOD_TEMPO.tail!, periodSeconds: (60 / 128) * 1.12 },
      }),
    });
    const outcome = await analyzer.analyze({ audio: AUDIO, targetBpm: 128 });
    expect(outcome.analysisStatus).toBe('partial');
    expect(outcome.bpmSource).toBe('anchored');
  });

  it('legacy request without a target → partial (loudness only), estimator never runs', async () => {
    const { analyzer, estimate } = stubbedAnalyzer();
    const outcome = await analyzer.analyze({ audio: AUDIO, targetBpm: null });
    expect(outcome.analysisStatus).toBe('partial');
    expect(outcome.bpmSource).toBe('anchored');
    expect(outcome.integratedLufs).toBeCloseTo(-12.9, 5);
    expect(estimate).not.toHaveBeenCalled();
  });

  it('over-duration input → failed (permanent guard, no staging)', async () => {
    const stage = vi.fn();
    const { analyzer } = stubbedAnalyzer({ stage: stage as never });
    const outcome = await analyzer.analyze({
      audio: { ...AUDIO, durationSeconds: MAX_ANALYSIS_INPUT_SECONDS + 1 },
      targetBpm: 128,
    });
    expect(outcome.analysisStatus).toBe('failed');
    expect(outcome.diagnostic).toMatch(/too long/);
    expect(stage).not.toHaveBeenCalled();
  });

  it('staging guard violation (oversize / no headroom) → failed with the diagnostic', async () => {
    const { analyzer } = stubbedAnalyzer({
      stage: async () => {
        throw new AnalysisInputError('analysis input too large: 999 bytes');
      },
    });
    const outcome = await analyzer.analyze({ audio: AUDIO, targetBpm: 128 });
    expect(outcome.analysisStatus).toBe('failed');
    expect(outcome.diagnostic).toMatch(/too large/);
  });

  it('transient trouble rejects so Graphile retries (never silently failed)', async () => {
    const { analyzer } = stubbedAnalyzer({
      measure: async () => {
        throw new Error('ffmpeg exited with 1: boom');
      },
    });
    await expect(analyzer.analyze({ audio: AUDIO, targetBpm: 128 })).rejects.toThrow(/exited/);
  });

  it('cleans the staged file up even when a later stage throws', async () => {
    const cleanup = vi.fn(async () => {});
    const analyzer = createWorkerTrackAnalyzer({
      storage: {} as never,
      probeFfmpeg: async () => true,
      stage: (async () => ({ path: '/tmp/staged', cleanup })) as never,
      measure: (async () => {
        throw new Error('transient');
      }) as never,
    });
    await expect(analyzer.analyze({ audio: AUDIO, targetBpm: 128 })).rejects.toThrow();
    expect(cleanup).toHaveBeenCalled();
  });

  it('a HUNG storage stage cannot outlive the job deadline (serialized queue never wedges)', async () => {
    // The stage's own timeout only covers the byte copy; a wedged stat()/
    // readStream() (e.g. a future S3 adapter) is caught by the deadline race.
    const analyzer = createWorkerTrackAnalyzer({
      storage: {} as never,
      probeFfmpeg: async () => true,
      stage: (() => new Promise(() => {})) as never,
      jobDeadlineMs: 300,
    });
    await expect(analyzer.analyze({ audio: AUDIO, targetBpm: 128 })).rejects.toThrow(
      /deadline exceeded during staging/,
    );
  });

  it('an exhausted job deadline rejects instead of starting another stage', async () => {
    const { analyzer } = stubbedAnalyzer();
    const impatient = createWorkerTrackAnalyzer({
      storage: {} as never,
      probeFfmpeg: async () => true,
      jobDeadlineMs: -1,
    });
    await expect(impatient.analyze({ audio: AUDIO, targetBpm: 128 })).rejects.toThrow(/deadline/);
    // Sanity: the same input succeeds under a normal deadline.
    await expect(analyzer.analyze({ audio: AUDIO, targetBpm: 128 })).resolves.toMatchObject({
      analysisStatus: 'measured',
    });
  });

  it('probes ffmpeg once per analyzer instance (boot-probe semantics)', async () => {
    const probe = vi.fn(async () => true);
    const { analyzer } = (() => {
      const cleanup = vi.fn(async () => {});
      return {
        analyzer: createWorkerTrackAnalyzer({
          storage: {} as never,
          probeFfmpeg: probe,
          stage: (async () => ({ path: '/tmp/staged', cleanup })) as never,
          measure: (async () => ({ integratedLufs: -12, truePeakDb: -2 })) as never,
          decode: (async () => new Float32Array(16)) as never,
          estimate: (async () => GOOD_TEMPO) as never,
        }),
      };
    })();
    await analyzer.analyze({ audio: AUDIO, targetBpm: 128 });
    await analyzer.analyze({ audio: AUDIO, targetBpm: 128 });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

// ---- End-to-end against real ffmpeg (skipped when the host has none) --------

const ffmpegPresent = await isFfmpegAvailable();

describe.skipIf(!ffmpegPresent)('end-to-end with real ffmpeg + real estimator thread', () => {
  let mock: MockStorage | null = null;
  afterEach(async () => {
    await mock?.cleanup();
    mock = null;
  });

  it('measures a click-track WAV: measured status, plausible LUFS/TP, both grids', async () => {
    mock = createMockStorageProvider();
    const { pcm } = clickTrack(120, 70);
    const key = 'tracks/u/session-x/click.wav';
    await mock.provider.write({ key, body: pcmToWav(pcm, 22050) });

    const analyzer = createWorkerTrackAnalyzer({ storage: mock.provider });
    const outcome = await analyzer.analyze({
      audio: { storageKey: key, durationSeconds: 70 },
      targetBpm: 120,
    });

    expect(outcome.analysisStatus).toBe('measured');
    expect(outcome.bpmSource).toBe('measured');
    expect(Math.abs(outcome.bpmEstimate! - 120)).toBeLessThan(1.2);
    expect(outcome.bpmConfidence).toBeGreaterThanOrEqual(0.75);
    // A sparse click train is quiet but loud at the peak.
    expect(outcome.integratedLufs).toBeLessThan(-10);
    expect(outcome.integratedLufs).toBeGreaterThan(-45);
    expect(outcome.truePeakDb).toBeLessThan(0);
    expect(outcome.headBeatPeriodSeconds).toBeCloseTo(0.5, 1);
    expect(outcome.tailBeatPeriodSeconds).toBeCloseTo(0.5, 1);
  }, 60_000);
});
