import { describe, expect, it } from 'vitest';
import type { CostComparisonData } from '@liedmotif/shared';
import { costGroups, costPeriodLabel, splitRows } from './costs-model';

const data: CostComparisonData = {
  range: '30d',
  timezone: 'Europe/Berlin',
  from: '2026-05-30T22:00:00.000Z',
  unitCosts: { perTrackUsd: 0.04, perCoverUsd: 0.1 },
  own: { tracks: 10, covers: 2 },
  members: { tracks: 26, covers: 1 },
  formerMembers: { tracks: 4, covers: 0 },
  total: { tracks: 36, covers: 3 },
  perMember: [
    { userId: 'u-lisa', name: 'Lisa', tracks: 2, covers: 0 },
    { userId: 'u-omar', name: 'Omar', tracks: 20, covers: 1 },
  ],
};

describe('costGroups', () => {
  it('prices every group at the current Unit costs, and the parts add up to the total', () => {
    const groups = costGroups(data);
    expect(groups.total.estimate).toBe('$1.74');
    expect(groups.own.estimate).toBe('$0.60');
    expect(groups.members.estimate).toBe('$1.14');
    expect(groups.perMember.map((row) => [row.label, row.estimate])).toEqual([
      ['Omar', '$0.90'],
      ['Lisa', '$0.08'],
      ['Former members', '$0.16'],
    ]);
  });

  it('reprices the same counts when a price changes', () => {
    const repriced = costGroups({ ...data, unitCosts: { perTrackUsd: 0.5, perCoverUsd: 0.1 } });
    expect(repriced.own.estimate).toBe('$5.20');
  });

  it('shows counts without dollars while both prices are zero', () => {
    const groups = costGroups({ ...data, unitCosts: { perTrackUsd: 0, perCoverUsd: 0 } });
    expect(groups.priced).toBe(false);
    expect(groups.total.estimate).toBeNull();
    expect(groups.total.counts).toEqual({ tracks: 36, covers: 3 });
  });

  it('leaves Former members out while nobody deleted has spent', () => {
    const groups = costGroups({ ...data, formerMembers: { tracks: 0, covers: 0 } });
    expect(groups.perMember.map((row) => row.label)).toEqual(['Omar', 'Lisa']);
  });
});

describe('splitRows', () => {
  it('charts each group as Music and Covers dollars that add up to its estimate', () => {
    const groups = costGroups(data);
    expect(splitRows([groups.own], data.unitCosts)).toEqual([
      {
        key: 'own',
        label: 'You',
        music: { value: 0.4, reading: '$0.40, 10 tracks' },
        covers: { value: 0.2, reading: '$0.20, 2 covers' },
        reading: '$0.60',
      },
    ]);
  });

  it('charts plain counts while no price is set', () => {
    const unpriced = { perTrackUsd: 0, perCoverUsd: 0 };
    const groups = costGroups({ ...data, unitCosts: unpriced });
    expect(splitRows([groups.own], unpriced)[0]).toMatchObject({
      music: { value: 10, reading: '10 tracks' },
      covers: { value: 2, reading: '2 covers' },
      reading: '12',
    });
  });
});

describe('costPeriodLabel', () => {
  it('names the budget timezone the period is cut in', () => {
    expect(costPeriodLabel(data)).toBe('Since 31 May 2026 · Budget Timezone Europe/Berlin');
    expect(costPeriodLabel({ ...data, from: null })).toBe(
      'All Time · Budget Timezone Europe/Berlin',
    );
  });
});
