import { describe, expect, it } from 'vitest';
import {
  CURRENT_ANALYSIS_VERSION,
  toBlendAnalysis,
  toBlendAnalysisStatus,
  validateTrackAnalysis,
  type TrackAnalysisFields,
} from './blend';

const measuredFields: TrackAnalysisFields = {
  analysisStatus: 'measured',
  analysisVersion: CURRENT_ANALYSIS_VERSION,
  bpmEstimate: 123.6,
  bpmSource: 'measured',
  bpmConfidence: 0.9,
  headBeatAnchorSeconds: 0.5,
  headBeatPeriodSeconds: 60 / 123.6,
  tailBeatAnchorSeconds: 180,
  tailBeatPeriodSeconds: 60 / 123.5,
  lufsIntegrated: -13.2,
  truePeakDb: -1.4,
};

describe('toBlendAnalysisStatus', () => {
  it('maps the DB provenance to the queue contract vocabulary', () => {
    expect(toBlendAnalysisStatus('pending')).toBeNull();
    expect(toBlendAnalysisStatus('measured')).toBe('complete');
    expect(toBlendAnalysisStatus('partial')).toBe('partial');
    expect(toBlendAnalysisStatus('unavailable')).toBe('unavailable');
    expect(toBlendAnalysisStatus('failed')).toBe('failed');
  });
});

describe('toBlendAnalysis', () => {
  it('maps a measured analysis to the contract shape', () => {
    expect(toBlendAnalysis(measuredFields)).toEqual({
      version: CURRENT_ANALYSIS_VERSION,
      status: 'complete',
      bpm: 123.6,
      bpmSource: 'measured',
      bpmConfidence: 0.9,
      headBeatAnchorSeconds: 0.5,
      headBeatPeriodSeconds: 60 / 123.6,
      tailBeatAnchorSeconds: 180,
      tailBeatPeriodSeconds: 60 / 123.5,
      integratedLufs: -13.2,
      truePeakDb: -1.4,
    });
  });

  it('reports nothing for a pending (never analyzed) track', () => {
    expect(toBlendAnalysis({ ...measuredFields, analysisStatus: 'pending' })).toBeNull();
  });

  it('suppresses a STALE analyzer version (server-side omission rule)', () => {
    expect(
      toBlendAnalysis({ ...measuredFields, analysisVersion: CURRENT_ANALYSIS_VERSION - 1 }),
    ).toBeNull();
    expect(toBlendAnalysis({ ...measuredFields, analysisVersion: null })).toBeNull();
  });
});

describe('validateTrackAnalysis', () => {
  it('accepts a plausible measured write', () => {
    expect(validateTrackAnalysis(measuredFields, { targetBpm: 124 })).toEqual([]);
  });

  it('accepts an all-null write (a failed analysis reports status only)', () => {
    expect(validateTrackAnalysis({})).toEqual([]);
  });

  it.each([
    ['BPM below 40', { bpmEstimate: 20 }],
    ['BPM above 220', { bpmEstimate: 500 }],
    ['non-finite BPM', { bpmEstimate: Number.NaN }],
    ['LUFS above 0', { integratedLufs: 2 }],
    ['LUFS below -70', { integratedLufs: -90 }],
    ['true peak above +3 dB', { truePeakDb: 4 }],
    ['true peak below -20 dB', { truePeakDb: -30 }],
    ['confidence above 1', { bpmConfidence: 1.2 }],
    ['negative anchor', { tailBeatAnchorSeconds: -0.1 }],
    ['non-positive period', { headBeatPeriodSeconds: 0 }],
  ])('rejects %s', (_name, bad) => {
    expect(validateTrackAnalysis(bad).length).toBeGreaterThan(0);
  });

  it('enforces the ±10% period window around the target beat period', () => {
    // Target 120 BPM → 0.5 s period. 0.54 s is 8% off (ok); 0.6 s is 20% (rejected).
    expect(validateTrackAnalysis({ headBeatPeriodSeconds: 0.54 }, { targetBpm: 120 })).toEqual([]);
    expect(
      validateTrackAnalysis({ headBeatPeriodSeconds: 0.6 }, { targetBpm: 120 }).length,
    ).toBeGreaterThan(0);
  });

  it('skips the period-window check when no target exists (unanchored analysis)', () => {
    expect(validateTrackAnalysis({ headBeatPeriodSeconds: 0.6 }, { targetBpm: null })).toEqual([]);
  });
});
