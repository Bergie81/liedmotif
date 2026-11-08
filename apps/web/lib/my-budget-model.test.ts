import { describe, expect, it } from 'vitest';
import { buildMyBudgetData } from './my-budget-model';

const YOURS = {
  kind: 'rolling' as const,
  caps: {
    dailyGenerationTasks: 10,
    monthlyGenerationTasks: 50,
    generatedCoversPerDay: 10,
    generatedCoversPerMonth: 60,
  },
  used: { dailyTasks: 3, monthlyTasks: 12, coversDay: 2, coversMonth: 7 },
};

const SHARED = {
  caps: {
    dailyGenerationTasks: 40,
    monthlyGenerationTasks: 200,
    generatedCoversPerDay: 30,
    generatedCoversPerMonth: 200,
  },
  used: { dailyTasks: 15, monthlyTasks: 90, coversDay: 9, coversMonth: 44 },
};

describe('buildMyBudgetData', () => {
  it('converts every task figure to tracks and passes covers through', () => {
    const data = buildMyBudgetData({
      yours: YOURS,
      shared: SHARED,
      tracksPerCall: 2,
      resetTimezone: 'Europe/Berlin',
    });
    expect(data.yours).toEqual({
      kind: 'rolling',
      figures: {
        tracksDay: { used: 6, limit: 20, remaining: 14 },
        tracksMonth: { used: 24, limit: 100, remaining: 76 },
        coversDay: { used: 2, limit: 10, remaining: 8 },
        coversMonth: { used: 7, limit: 60, remaining: 53 },
      },
    });
    expect(data.shared.tracksDay).toEqual({ used: 30, limit: 80, remaining: 50 });
    expect(data.shared.coversDay).toEqual({ used: 9, limit: 30, remaining: 21 });
    expect(data.resetTimezone).toBe('Europe/Berlin');
  });

  it('never reports negative remaining for an over-cap window', () => {
    const data = buildMyBudgetData({
      yours: { ...YOURS, used: { ...YOURS.used, dailyTasks: 99, coversDay: 99 } },
      shared: SHARED,
      tracksPerCall: 2,
      resetTimezone: 'UTC',
    });
    if (data.yours.kind !== 'rolling') throw new Error('expected rolling');
    expect(data.yours.figures.tracksDay).toEqual({ used: 198, limit: 20, remaining: 0 });
    expect(data.yours.figures.coversDay.remaining).toBe(0);
  });

  it('shows a zero cap as zero everything, never unlimited', () => {
    const data = buildMyBudgetData({
      yours: {
        ...YOURS,
        caps: { ...YOURS.caps, dailyGenerationTasks: 0 },
        used: { ...YOURS.used, dailyTasks: 0 },
      },
      shared: SHARED,
      tracksPerCall: 2,
      resetTimezone: 'UTC',
    });
    if (data.yours.kind !== 'rolling') throw new Error('expected rolling');
    expect(data.yours.figures.tracksDay).toEqual({ used: 0, limit: 0, remaining: 0 });
  });

  it('shows a One-time budget as two totals counted since the Grant, in tracks and covers', () => {
    const data = buildMyBudgetData({
      yours: {
        kind: 'oneTime',
        totals: { totalGenerationTasks: 13, totalGeneratedCovers: 60 },
        used: { tasks: 5, covers: 7 },
      },
      shared: SHARED,
      tracksPerCall: 2,
      resetTimezone: 'UTC',
    });
    expect(data.yours).toEqual({
      kind: 'oneTime',
      tracks: { used: 10, limit: 26, remaining: 16 },
      covers: { used: 7, limit: 60, remaining: 53 },
    });
    // The Pool meters are the same four windows whatever the Member's kind.
    expect(data.shared.tracksDay).toEqual({ used: 30, limit: 80, remaining: 50 });
  });

  it('carries only aggregates — the payload has no field for another member', () => {
    const data = buildMyBudgetData({
      yours: YOURS,
      shared: SHARED,
      tracksPerCall: 2,
      resetTimezone: 'UTC',
    });
    expect(Object.keys(data).sort()).toEqual(['resetTimezone', 'shared', 'yours']);
    expect(Object.keys(data.shared).sort()).toEqual([
      'coversDay',
      'coversMonth',
      'tracksDay',
      'tracksMonth',
    ]);
  });
});
