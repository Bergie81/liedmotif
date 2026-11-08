import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNIT_COSTS,
  estimatedCostUsd,
  UNIT_COST_CEILING_USD,
  unitCostsSchema,
  unitCostsSet,
} from './unit-costs';

describe('unit cost schema', () => {
  it('ships the measured provider prices as defaults and accepts whole cents up to the ceiling', () => {
    expect(unitCostsSchema.parse(DEFAULT_UNIT_COSTS)).toEqual({
      perTrackUsd: 0.04,
      perCoverUsd: 0.07,
    });
    expect(unitCostsSchema.safeParse({ perTrackUsd: 0.05, perCoverUsd: 0.1 }).success).toBe(true);
    expect(
      unitCostsSchema.safeParse({ perTrackUsd: UNIT_COST_CEILING_USD, perCoverUsd: 12.34 }).success,
    ).toBe(true);
  });

  it('rejects negatives, fractional cents, and prices above the ceiling', () => {
    expect(unitCostsSchema.safeParse({ perTrackUsd: -0.01, perCoverUsd: 0 }).success).toBe(false);
    expect(unitCostsSchema.safeParse({ perTrackUsd: 0.001, perCoverUsd: 0 }).success).toBe(false);
    expect(unitCostsSchema.safeParse({ perTrackUsd: 0.125, perCoverUsd: 0 }).success).toBe(false);
    expect(
      unitCostsSchema.safeParse({ perTrackUsd: 0, perCoverUsd: UNIT_COST_CEILING_USD + 0.01 })
        .success,
    ).toBe(false);
  });

  it('counts a price as set only above 0', () => {
    expect(unitCostsSet({ perTrackUsd: 0, perCoverUsd: 0 })).toBe(false);
    expect(unitCostsSet({ perTrackUsd: 0, perCoverUsd: 0.01 })).toBe(true);
    expect(unitCostsSet(DEFAULT_UNIT_COSTS)).toBe(true);
  });
});

describe('estimated cost', () => {
  it('multiplies Tracks and Covers by their prices into one figure, rounded to cents', () => {
    const costs = { perTrackUsd: 0.1, perCoverUsd: 0.05 };
    // 3 × 0.1 is 0.30000000000000004 in doubles — the readout must not show it.
    expect(estimatedCostUsd({ tracks: 3, covers: 0 }, costs)).toBe(0.3);
    expect(estimatedCostUsd({ tracks: 25, covers: 60 }, costs)).toBe(5.5);
    expect(estimatedCostUsd({ tracks: 0, covers: 0 }, costs)).toBe(0);
  });

  it('prices at 0 contribute nothing', () => {
    expect(estimatedCostUsd({ tracks: 100, covers: 60 }, { perTrackUsd: 0, perCoverUsd: 0 })).toBe(
      0,
    );
    expect(
      estimatedCostUsd({ tracks: 100, covers: 60 }, { perTrackUsd: 0, perCoverUsd: 0.5 }),
    ).toBe(30);
  });
});
