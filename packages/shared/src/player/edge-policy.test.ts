import { describe, expect, it } from 'vitest';
import type { BlendAnalysis } from '../contracts/blend';
import { decideEdge, type EdgeEndpoint } from './edge-policy';

// The edge-policy decision table: measured BPM only with complete
// measured provenance at/above the confidence floor, EQUAL analyzer versions,
// same style revision, matching target key, and drift within bounds; `partial`
// gets loudness normalization only; null identity → plain, always (legacy).

function analysis(over: Partial<BlendAnalysis> = {}): BlendAnalysis {
  return {
    version: 2,
    status: 'complete',
    bpm: 120.4,
    bpmSource: 'measured',
    bpmConfidence: 0.9,
    headBeatAnchorSeconds: 0.31,
    headBeatPeriodSeconds: 0.4986,
    tailBeatAnchorSeconds: 150.02,
    tailBeatPeriodSeconds: 0.4989,
    integratedLufs: -13.1,
    truePeakDb: -1.9,
    ...over,
  };
}

function endpoint(over: Partial<EdgeEndpoint> = {}): EdgeEndpoint {
  return {
    source: 'final',
    styleRevision: 3,
    targetBpm: 120,
    targetKey: 'A minor',
    analysis: analysis(),
    ...over,
  };
}

const media = { transport: 'media' } as const;

describe('decideEdge', () => {
  it('qualifies a fully measured same-revision final↔final edge as beat-aligned on media decks', () => {
    const d = decideEdge(endpoint(), endpoint(), media);
    expect(d.tier).toBe('beat-aligned');
    expect(d.reasons).toEqual([]);
    expect(d.loudnessNormalized).toBe(true);
  });

  it('qualifies the same edge as beat-locked on buffer transport', () => {
    const d = decideEdge(endpoint(), endpoint(), { ...media, transport: 'buffer' });
    expect(d.tier).toBe('beat-locked');
  });

  it('forces plain for a stream (cold-start) source on either side', () => {
    expect(decideEdge(endpoint({ source: 'stream' }), endpoint(), media).tier).toBe('plain');
    expect(decideEdge(endpoint(), endpoint({ source: 'stream' }), media).tier).toBe('plain');
    expect(decideEdge(endpoint({ source: 'stream' }), endpoint(), media).reasons).toContain(
      'source-not-final',
    );
  });

  it('forces plain for legacy null identity on either side, always', () => {
    const legacy = endpoint({ styleRevision: null, targetBpm: null, targetKey: null });
    expect(decideEdge(legacy, endpoint(), media).tier).toBe('plain');
    expect(decideEdge(endpoint(), legacy, media).tier).toBe('plain');
    expect(decideEdge(legacy, endpoint(), media).reasons).toContain('legacy-identity');
  });

  it('forces plain when ANY identity component is null (partial/backfill rows)', () => {
    // New submits always freeze revision + BPM + key; a hole in any component
    // means the generation identity is unknown — never a silent guess.
    for (const partial of [
      endpoint({ targetBpm: null }),
      endpoint({ targetKey: null }),
      endpoint({ styleRevision: null }),
    ]) {
      const d = decideEdge(partial, endpoint(), media);
      expect(d.tier).toBe('plain');
      expect(d.reasons).toContain('legacy-identity');
    }
  });

  it('forces plain across a Change Vibe boundary (style revision mismatch)', () => {
    const d = decideEdge(endpoint({ styleRevision: 3 }), endpoint({ styleRevision: 4 }), media);
    expect(d.tier).toBe('plain');
    expect(d.reasons).toContain('revision-mismatch');
  });

  it('forces plain on a target-key mismatch', () => {
    const d = decideEdge(
      endpoint({ targetKey: 'A minor' }),
      endpoint({ targetKey: 'C major' }),
      media,
    );
    expect(d.tier).toBe('plain');
    expect(d.reasons).toContain('key-mismatch');
  });

  it('treats two null target keys as LEGACY, not as a match', () => {
    const d = decideEdge(endpoint({ targetKey: null }), endpoint({ targetKey: null }), media);
    expect(d.tier).toBe('plain');
    expect(d.reasons).toContain('legacy-identity');
  });

  it('forces plain when either analysis is missing or not complete', () => {
    expect(decideEdge(endpoint({ analysis: null }), endpoint(), media).tier).toBe('plain');
    const failed = endpoint({
      analysis: analysis({
        status: 'failed',
        bpm: null,
        bpmSource: null,
        bpmConfidence: null,
        headBeatAnchorSeconds: null,
        headBeatPeriodSeconds: null,
        tailBeatAnchorSeconds: null,
        tailBeatPeriodSeconds: null,
        integratedLufs: null,
        truePeakDb: null,
      }),
    });
    expect(decideEdge(failed, endpoint(), media).tier).toBe('plain');
  });

  it('gives partial analysis loudness normalization but a plain tier', () => {
    const partial = endpoint({
      analysis: analysis({
        status: 'partial',
        bpmSource: 'anchored',
        bpmConfidence: 0.2,
        headBeatAnchorSeconds: null,
        headBeatPeriodSeconds: null,
        tailBeatAnchorSeconds: null,
        tailBeatPeriodSeconds: null,
      }),
    });
    const d = decideEdge(partial, endpoint(), media);
    expect(d.tier).toBe('plain');
    expect(d.loudnessNormalized).toBe(true);
  });

  it('never aligns on anchored BPM even when confident', () => {
    const anchored = endpoint({ analysis: analysis({ bpmSource: 'anchored' }) });
    const d = decideEdge(anchored, endpoint(), media);
    expect(d.tier).toBe('plain');
    expect(d.reasons).toContain('bpm-not-measured');
  });

  it('refuses below the confidence floor', () => {
    const shaky = endpoint({ analysis: analysis({ bpmConfidence: 0.74 }) });
    expect(decideEdge(shaky, endpoint(), media).reasons).toContain('confidence-below-floor');
  });

  it('requires the CURRENT analyzer version on both decks (bias cancels only then)', () => {
    const newer = endpoint({ analysis: analysis({ version: 3 }) });
    const d = decideEdge(newer, endpoint(), media);
    expect(d.tier).toBe('plain');
    expect(d.reasons).toContain('version-mismatch');
    // Loudness normalization does not depend on version equality.
    expect(d.loudnessNormalized).toBe(true);
  });

  it('refuses two matching FUTURE versions (rolling deployment: newer worker, older web)', () => {
    const future = () => endpoint({ analysis: analysis({ version: 3 }) });
    const d = decideEdge(future(), future(), media);
    expect(d.tier).toBe('plain');
    expect(d.reasons).toContain('version-mismatch');
    // An explicitly newer build accepts its own current version.
    expect(decideEdge(future(), future(), { ...media, currentAnalysisVersion: 3 }).tier).toBe(
      'beat-aligned',
    );
  });

  it('refuses a malformed complete payload whose measured BPM is null', () => {
    const noBpm = endpoint({ analysis: analysis({ bpm: null }) });
    const d = decideEdge(noBpm, endpoint(), media);
    expect(d.tier).toBe('plain');
    expect(d.reasons).toContain('bpm-not-measured');
  });

  it('leaves the pitch cap to the scheduler: a large period mismatch still QUALIFIES here', () => {
    // The applied rate depends on the outgoing deck's live playback rate
    // (chained edges), which the policy cannot know — `planEdge` enforces the
    // cap once on the final rate and degrades with `rate-beyond-cap`.
    const slow = endpoint({
      analysis: analysis({ headBeatPeriodSeconds: 0.54, tailBeatPeriodSeconds: 0.54 }),
    });
    expect(decideEdge(endpoint(), slow, media).tier).toBe('beat-aligned');
  });

  it('caps at beat-aligned when a track’s head/tail periods diverge beyond the drift guard', () => {
    // 0.3% divergence within one track (> 0.25% guard): buffer transport still
    // only gets beat-aligned; media transport is unaffected (already the cap).
    const drifty = endpoint({
      analysis: analysis({ headBeatPeriodSeconds: 0.5, tailBeatPeriodSeconds: 0.5015 }),
    });
    expect(decideEdge(drifty, endpoint(), { ...media, transport: 'buffer' }).tier).toBe(
      'beat-aligned',
    );
    expect(decideEdge(drifty, endpoint(), media).tier).toBe('beat-aligned');
  });

  it('normalizes loudness on plain edges when both sides measured it', () => {
    const d = decideEdge(endpoint({ styleRevision: 3 }), endpoint({ styleRevision: 4 }), media);
    expect(d.tier).toBe('plain');
    expect(d.loudnessNormalized).toBe(true);
  });

  it('skips loudness normalization when either side lacks a measurement', () => {
    const noLufs = endpoint({ analysis: analysis({ integratedLufs: null }) });
    expect(decideEdge(noLufs, endpoint(), media).loudnessNormalized).toBe(false);
    expect(decideEdge(endpoint({ analysis: null }), endpoint(), media).loudnessNormalized).toBe(
      false,
    );
  });
});
