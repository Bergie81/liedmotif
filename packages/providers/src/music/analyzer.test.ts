import { describe, expect, it } from 'vitest';
import { anchoredBpmEstimate, targetAnchoredBpmAnalyzer } from './analyzer';

// The per-track BPM estimate anchors
// to the REQUEST's persisted generation-time target BPM — never the live snapshot.
// The dependency-free fallback analyzer decodes no audio: a small, deterministic,
// audio-fingerprinted drift with `bpmSource: 'anchored'` (which can never activate
// beat-locking) and `analysisStatus: 'unavailable'` (what the worker boot probe
// re-enqueues once ffmpeg appears). It produces NO musical key: measured key is
// deferred.
const analyzer = targetAnchoredBpmAnalyzer();

describe('anchoredBpmEstimate', () => {
  it('is deterministic for the same audio + target pair', () => {
    const args = { audio: { checksum: 'abc123' }, targetBpm: 110 };
    expect(anchoredBpmEstimate(args)).toEqual(anchoredBpmEstimate(args));
  });

  it('anchors the estimate within a small drift of the target BPM', () => {
    const { bpmEstimate } = anchoredBpmEstimate({
      audio: { checksum: 'track-1' },
      targetBpm: 128,
    });
    expect(Math.abs(bpmEstimate - 128)).toBeLessThanOrEqual(2);
  });

  it('estimates per track: different audio fingerprints can drift differently', () => {
    const a = anchoredBpmEstimate({ audio: { checksum: 'aaaa' }, targetBpm: 110 });
    const b = anchoredBpmEstimate({ audio: { checksum: 'zzzz' }, targetBpm: 110 });
    // Both anchored to 110, but the drift is fingerprint-derived, not a constant copy.
    expect(a.bpmEstimate).not.toBe(b.bpmEstimate);
  });

  it('clamps extreme targets into the persistable 40–220 range (write bounds)', () => {
    // A schema-valid but extreme LLM-frozen target must never produce an
    // estimate the analysis write rejects (which would leave the track pending
    // forever) — the estimate clamps to the shared bounds instead.
    const high = anchoredBpmEstimate({ audio: { checksum: 'hi' }, targetBpm: 300 });
    expect(high.bpmEstimate).toBeLessThanOrEqual(220);
    const low = anchoredBpmEstimate({ audio: { checksum: 'lo' }, targetBpm: 20 });
    expect(low.bpmEstimate).toBeGreaterThanOrEqual(40);
  });

  it('falls back to a sane BPM when the request froze no target (legacy rows)', () => {
    const { bpmEstimate, bpmSource } = anchoredBpmEstimate({
      audio: { storageKey: 'k/x.mp3' },
      targetBpm: null,
    });
    expect(bpmEstimate).toBeGreaterThan(0);
    expect(bpmSource).toBe('anchored');
  });
});

describe('targetAnchoredBpmAnalyzer', () => {
  it('reports honest provenance: anchored source, nothing measured, unavailable', async () => {
    const outcome = await analyzer.analyze({ audio: { checksum: 'track-1' }, targetBpm: 128 });
    expect(outcome.analysisStatus).toBe('unavailable');
    expect(outcome.bpmSource).toBe('anchored');
    expect(outcome.bpmConfidence).toBeNull();
    expect(outcome.integratedLufs).toBeNull();
    expect(outcome.truePeakDb).toBeNull();
    expect(outcome.headBeatAnchorSeconds).toBeNull();
    expect(outcome.tailBeatPeriodSeconds).toBeNull();
  });

  it('carries the shared anchored estimate verbatim', async () => {
    const input = { audio: { checksum: 'track-2' }, targetBpm: 140 };
    const outcome = await analyzer.analyze(input);
    expect(outcome.bpmEstimate).toBe(anchoredBpmEstimate(input).bpmEstimate);
  });
});
