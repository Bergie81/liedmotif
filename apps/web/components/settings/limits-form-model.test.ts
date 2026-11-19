import { describe, expect, it } from 'vitest';
import { defaultUsageLimits } from '@liedmotif/db';
import { USAGE_LIMIT_CEILINGS } from '@liedmotif/shared';
import { providerTasksToTracks } from '@/lib/budget/track-units';
import {
  buildLimitsPatch,
  createLimitFormValues,
  limitFieldMax,
  limitFieldMin,
  limitFieldWarnings,
  stepLimitValue,
} from './limits-form-model';

describe('generation limit form units', () => {
  it('shows provider-call limits in Tracks and converts them back exactly', () => {
    const initial = defaultUsageLimits();
    const values = createLimitFormValues(initial, 2);

    expect(values).toMatchObject({
      dailyTracks: '50',
      monthlyTracks: '250',
      concurrentTracks: '2',
      storageQuotaBytes: String(10 * 1024 ** 3),
    });
    expect(buildLimitsPatch(values, 2)).toEqual({
      ok: true,
      patch: expect.objectContaining({
        dailyGenerationTasks: 25,
        monthlyGenerationTasks: 125,
        maxConcurrentJobs: 1,
        storageQuotaBytes: 10 * 1024 ** 3,
      }),
    });
  });

  it('carries the tailored cover toggle through values and the patch', () => {
    const values = createLimitFormValues(defaultUsageLimits(), 2);
    expect(values).toMatchObject({ tailoredCoverArtEnabled: true });

    const patched = buildLimitsPatch({ ...values, tailoredCoverArtEnabled: false }, 2);
    expect(patched).toMatchObject({
      ok: true,
      patch: expect.objectContaining({ tailoredCoverArtEnabled: false }),
    });
  });

  it('carries the Admin Track ceiling switch through values and the patch', () => {
    const values = createLimitFormValues(
      { ...defaultUsageLimits(), trackCeilingEnabled: false },
      2,
    );
    expect(values).toMatchObject({ trackCeilingEnabled: false });

    expect(buildLimitsPatch({ ...values, trackCeilingEnabled: true }, 2)).toMatchObject({
      ok: true,
      patch: expect.objectContaining({ trackCeilingEnabled: true }),
    });
  });

  it('carries the Admin Cover ceiling switch through values and the patch', () => {
    const values = createLimitFormValues(
      { ...defaultUsageLimits(), coverCeilingEnabled: false },
      2,
    );
    expect(values).toMatchObject({ coverCeilingEnabled: false });

    expect(buildLimitsPatch({ ...values, coverCeilingEnabled: true }, 2)).toMatchObject({
      ok: true,
      patch: expect.objectContaining({ coverCeilingEnabled: true }),
    });
  });

  it('neither validates nor writes the caps of a switched-off ceiling', () => {
    const values = {
      ...createLimitFormValues(defaultUsageLimits(), 2),
      trackCeilingEnabled: false,
      coverCeilingEnabled: false,
      dailyTracks: '81',
      generatedCoversPerMonth: '',
    };

    const result = buildLimitsPatch(values, 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).not.toHaveProperty('dailyGenerationTasks');
    expect(result.patch).not.toHaveProperty('monthlyGenerationTasks');
    expect(result.patch).not.toHaveProperty('generatedCoversPerDay');
    expect(result.patch).not.toHaveProperty('generatedCoversPerMonth');
    expect(result.patch).toMatchObject({ trackCeilingEnabled: false, maxConcurrentJobs: 1 });
  });

  it('rejects Track limits that cannot map to a whole provider call', () => {
    const values = createLimitFormValues(defaultUsageLimits(), 2);
    values.dailyTracks = '81';

    expect(buildLimitsPatch(values, 2)).toEqual({
      ok: false,
      errors: { dailyTracks: 'Enter a multiple of 2 Tracks.' },
    });
  });

  it('rejects empty, fractional, and negative persisted values', () => {
    const initial = createLimitFormValues(defaultUsageLimits(), 2);

    for (const value of ['', '1.5', '-1']) {
      expect(buildLimitsPatch({ ...initial, idleAutoStopAfterMinutes: value }, 2)).toMatchObject({
        ok: false,
        errors: { idleAutoStopAfterMinutes: 'Enter a whole number (0 or more).' },
      });
    }
  });

  it('steps values without crossing either bound', () => {
    expect(stepLimitValue('4', -5, 100)).toBe('0');
    expect(stepLimitValue('10', 5, 100)).toBe('15');
    expect(stepLimitValue('not-a-number', 2, 100)).toBe('2');
    // At the ceiling the stepper stops, rather than walking into a value the
    // route refuses with its internal, task-unit message.
    expect(stepLimitValue('98', 5, 100)).toBe('100');
  });

  it('holds the queue depth at 1 or more', () => {
    const initial = createLimitFormValues(defaultUsageLimits(), 2);
    expect(buildLimitsPatch({ ...initial, maxQueuedTracks: '0' }, 2)).toEqual({
      ok: false,
      errors: { maxQueuedTracks: 'Enter 1 or more.' },
    });
    expect(buildLimitsPatch({ ...initial, maxQueuedTracks: '1' }, 2)).toMatchObject({
      ok: true,
      patch: { maxQueuedTracks: 1 },
    });
    expect(limitFieldMin('maxQueuedTracks', 2)).toBe(1);
    expect(limitFieldMin('storageQuotaBytes', 2)).toBe(0);
    expect(stepLimitValue('3', -5, 100, limitFieldMin('maxQueuedTracks', 2))).toBe('1');
  });

  it('holds concurrency at one provider call, shown in Tracks', () => {
    const initial = createLimitFormValues(defaultUsageLimits(), 2);
    expect(buildLimitsPatch({ ...initial, concurrentTracks: '0' }, 2)).toEqual({
      ok: false,
      errors: { concurrentTracks: 'Enter 2 or more.' },
    });
    expect(buildLimitsPatch({ ...initial, concurrentTracks: '2' }, 2)).toMatchObject({
      ok: true,
      patch: { maxConcurrentJobs: 1 },
    });
    expect(limitFieldMin('concurrentTracks', 2)).toBe(2);
    expect(stepLimitValue('4', -6, 20, limitFieldMin('concurrentTracks', 2))).toBe('2');
  });

  it('reports an over-ceiling value per field, in the unit the row shows', () => {
    const initial = createLimitFormValues(defaultUsageLimits(), 2);
    const overCeiling = {
      ...initial,
      // The daily ceiling is counted in provider tasks; the row shows Tracks.
      dailyTracks: String(providerTasksToTracks(USAGE_LIMIT_CEILINGS.dailyGenerationTasks, 2) + 2),
      maxQueuedTracks: String(USAGE_LIMIT_CEILINGS.maxQueuedTracks + 1),
    };

    expect(buildLimitsPatch(overCeiling, 2)).toEqual({
      ok: false,
      errors: {
        dailyTracks: 'Enter at most 2000 Tracks.',
        maxQueuedTracks: 'Enter at most 100 Tracks.',
      },
    });
  });

  it('exposes each field ceiling in the unit its row shows', () => {
    expect(limitFieldMax('dailyTracks', 2)).toBe(2000);
    expect(limitFieldMax('concurrentTracks', 2)).toBe(40);
    expect(limitFieldMax('generatedCoversPerDay', 2)).toBe(
      USAGE_LIMIT_CEILINGS.generatedCoversPerDay,
    );
  });
});

describe('limits below the Session-start headroom', () => {
  const base = {
    ...createLimitFormValues(defaultUsageLimits(), 2),
    trackCeilingEnabled: true,
    minHeadroomTracksToStartSession: '5',
  };
  const warning = 'Below 5 Tracks, no new Session can start.';

  it('warns on a Daily or Monthly limit below the headroom and still saves it', () => {
    const low = { ...base, dailyTracks: '4', monthlyTracks: '2' };
    expect(limitFieldWarnings(low)).toEqual({ dailyTracks: warning, monthlyTracks: warning });
    expect(buildLimitsPatch(low, 2)).toEqual({
      ok: true,
      patch: expect.objectContaining({ dailyGenerationTasks: 2, monthlyGenerationTasks: 1 }),
    });
  });

  it('follows the headroom in the form, not the stored one', () => {
    expect(limitFieldWarnings({ ...base, dailyTracks: '6' })).toEqual({});
    expect(
      limitFieldWarnings({ ...base, dailyTracks: '6', minHeadroomTracksToStartSession: '8' }),
    ).toEqual({ dailyTracks: 'Below 8 Tracks, no new Session can start.' });
  });

  it('leaves a monthly limit below the daily one alone while both clear the headroom', () => {
    const tightMonth = { ...base, dailyTracks: '20', monthlyTracks: '10' };
    expect(limitFieldWarnings(tightMonth)).toEqual({});
    expect(buildLimitsPatch(tightMonth, 2)).toMatchObject({
      ok: true,
      patch: { dailyGenerationTasks: 10, monthlyGenerationTasks: 5 },
    });
  });

  it('treats 0 as a deliberate stop: no warning, and it saves', () => {
    const stopped = { ...base, dailyTracks: '0' };
    expect(limitFieldWarnings(stopped)).toEqual({});
    expect(buildLimitsPatch(stopped, 2)).toMatchObject({
      ok: true,
      patch: { dailyGenerationTasks: 0 },
    });
  });

  it('says nothing while the Track ceiling is off or the headroom gate is 0', () => {
    expect(limitFieldWarnings({ ...base, dailyTracks: '2', trackCeilingEnabled: false })).toEqual(
      {},
    );
    expect(
      limitFieldWarnings({ ...base, dailyTracks: '2', minHeadroomTracksToStartSession: '0' }),
    ).toEqual({});
  });

  it('never touches another limit to make a value fit', () => {
    const low = { ...base, dailyTracks: '2' };
    const result = buildLimitsPatch(low, 2);
    expect(result).toMatchObject({
      ok: true,
      patch: { dailyGenerationTasks: 1, minHeadroomTracksToStartSession: 5 },
    });
  });
});
