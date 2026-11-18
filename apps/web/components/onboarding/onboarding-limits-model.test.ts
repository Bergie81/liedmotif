import { describe, expect, it } from 'vitest';
import type { UsageLimits } from '@liedmotif/db';
import {
  bindingTrackCap,
  coverBudgetFromLimits,
  coverBudgetPatch,
  maxConcurrentTracks,
  stepLimit,
  trackCapFloor,
  trackCeilingFromLimits,
  trackCeilingPatch,
  type CoverBudget,
} from './onboarding-limits-model';

const limits = {
  trackCeilingEnabled: true,
  dailyGenerationTasks: 25,
  monthlyGenerationTasks: 250,
  maxConcurrentJobs: 1,
  tailoredCoverArtEnabled: true,
  coverCeilingEnabled: true,
  generatedCoversPerDay: 60,
  generatedCoversPerMonth: 600,
} as UsageLimits;

describe('trackCeilingFromLimits', () => {
  it('shows stored provider calls as the Tracks the owner actually hears', () => {
    expect(trackCeilingFromLimits(limits, 2)).toEqual({
      enabled: true,
      dailyTracks: '50',
      monthlyTracks: '500',
      concurrentTracks: '2',
    });
  });
});

describe('trackCeilingPatch', () => {
  const ceiling = {
    enabled: true,
    dailyTracks: '50',
    monthlyTracks: '500',
    concurrentTracks: '2',
  };

  it('round-trips back into provider calls', () => {
    expect(trackCeilingPatch(ceiling, 2)).toEqual({
      ok: true,
      patch: {
        trackCeilingEnabled: true,
        dailyGenerationTasks: 25,
        monthlyGenerationTasks: 250,
        maxConcurrentJobs: 1,
      },
    });
  });

  it('switched off, writes the switch and the concurrency only, leaving the stored caps as they were', () => {
    // A blank day figure must not block saving caps that are not being set.
    expect(trackCeilingPatch({ ...ceiling, enabled: false, dailyTracks: '' }, 2)).toEqual({
      ok: true,
      patch: { trackCeilingEnabled: false, maxConcurrentJobs: 1 },
    });
  });

  it('names the multiple a figure has to be, rather than refusing blankly', () => {
    expect(trackCeilingPatch({ ...ceiling, dailyTracks: '51' }, 2)).toEqual({
      ok: false,
      error: 'Enter a multiple of 2 Tracks.',
    });
  });

  it('refuses anything that is not a whole count', () => {
    for (const dailyTracks of ['', '-4', '2.5', 'lots']) {
      expect(trackCeilingPatch({ ...ceiling, dailyTracks }, 2)).toEqual({
        ok: false,
        error: 'Enter a whole number (0 or more).',
      });
    }
  });

  it('refuses a concurrency below one provider call, even with the caps switched off', () => {
    expect(trackCeilingPatch({ ...ceiling, enabled: false, concurrentTracks: '0' }, 2)).toEqual({
      ok: false,
      error: 'Enter 2 or more.',
    });
  });

  it('accepts zero, which deliberately blocks generation', () => {
    expect(trackCeilingPatch({ ...ceiling, dailyTracks: '0' }, 2)).toMatchObject({
      patch: { dailyGenerationTasks: 0 },
    });
  });
});

describe('maxConcurrentTracks', () => {
  it('caps concurrency on a figure the conversion can actually accept', () => {
    // A ceiling of 10 is not a whole number of 3-Track calls, so it rounds down
    // rather than offering a value the patch would reject.
    expect(maxConcurrentTracks(2)).toBe(10);
    expect(maxConcurrentTracks(3)).toBe(9);
    expect(maxConcurrentTracks(4)).toBe(8);
  });
});

describe('stepLimit', () => {
  it('keeps a ceiling inside the bounds its screen advertises', () => {
    expect(stepLimit('50', 10)).toBe('60');
    expect(stepLimit('4', -10, { min: 2 })).toBe('2');
    expect(stepLimit('8', 4, { max: 10 })).toBe('10');
    // Never below zero, even without an explicit floor.
    expect(stepLimit('5', -50)).toBe('0');
  });
});

describe('trackCapFloor', () => {
  it('stops a day or month cap stepping below the Tracks a new Session needs to start', () => {
    // Headroom 5 at 2 Tracks a call: 4 Tracks could never start a Session, 6 can.
    const min = trackCapFloor(5, 2);
    expect(stepLimit('50', -50, { min })).toBe('6');
    expect(stepLimit('8', -2, { min })).toBe('6');
    expect(stepLimit('6', -2, { min })).toBe('6');
  });

  it('is one provider call while the Session-start headroom is off', () => {
    expect(trackCapFloor(0, 2)).toBe(2);
    expect(stepLimit('4', -10, { min: trackCapFloor(0, 2) })).toBe('2');
  });

  it('is already a whole provider call when the headroom is one', () => {
    expect(trackCapFloor(6, 2)).toBe(6);
    expect(trackCapFloor(5, 3)).toBe(6);
  });
});

describe('bindingTrackCap', () => {
  const ceiling = { enabled: true, dailyTracks: '50', monthlyTracks: '500', concurrentTracks: '2' };

  it('names the day while the month allows at least as much', () => {
    expect(bindingTrackCap(ceiling)).toEqual({ tracks: 50, window: 'day' });
  });

  it('names the month when it is set below the day', () => {
    expect(bindingTrackCap({ ...ceiling, monthlyTracks: '10' })).toEqual({
      tracks: 10,
      window: 'month',
    });
  });
});

describe('cover budget', () => {
  const budget: CoverBudget = {
    tailoredCoverArtEnabled: true,
    ceilingEnabled: true,
    coversPerDay: '60',
    coversPerMonth: '600',
  };

  it('reads the stored shape the screen edits', () => {
    expect(coverBudgetFromLimits(limits)).toEqual(budget);
  });

  it('writes the switches and both ceilings, and nothing else', () => {
    // The screens split `usageLimits` between them, so a patch that carried more
    // would clobber a Track ceiling the other screen owns.
    expect(coverBudgetPatch(budget)).toEqual({
      ok: true,
      patch: {
        tailoredCoverArtEnabled: true,
        coverCeilingEnabled: true,
        generatedCoversPerDay: 60,
        generatedCoversPerMonth: 600,
      },
    });
  });

  it('switched off, writes the switches only, leaving the stored caps as they were', () => {
    expect(coverBudgetPatch({ ...budget, ceilingEnabled: false, coversPerDay: '' })).toEqual({
      ok: true,
      patch: { tailoredCoverArtEnabled: true, coverCeilingEnabled: false },
    });
  });

  it('refuses a ceiling that is not a whole count', () => {
    expect(coverBudgetPatch({ ...budget, coversPerMonth: '' })).toEqual({
      ok: false,
      error: 'Enter a whole number of Covers (0 or more).',
    });
  });
});
