import { afterEach, describe, expect, it } from 'vitest';
import { NUMERIC_LIMIT_KEYS, USAGE_LIMIT_CEILINGS } from '@liedmotif/shared';
import { DEFAULT_USAGE_LIMITS, defaultUsageLimits } from './settings';

// Unit test (no database): the seeded `resetTimezone` must never end up blank.
// `INSTANCE_TIMEZONE=''` or whitespace would slip past a plain `??`, so
// `defaultUsageLimits` trims-and-defaults the env (and explicit) value.
describe('defaultUsageLimits', () => {
  const original = process.env.INSTANCE_TIMEZONE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.INSTANCE_TIMEZONE;
    } else {
      process.env.INSTANCE_TIMEZONE = original;
    }
  });

  it('falls back to UTC when INSTANCE_TIMEZONE is unset', () => {
    delete process.env.INSTANCE_TIMEZONE;
    expect(defaultUsageLimits().resetTimezone).toBe('UTC');
  });

  it('falls back to UTC when INSTANCE_TIMEZONE is empty', () => {
    process.env.INSTANCE_TIMEZONE = '';
    expect(defaultUsageLimits().resetTimezone).toBe('UTC');
  });

  it('falls back to UTC when INSTANCE_TIMEZONE is whitespace', () => {
    process.env.INSTANCE_TIMEZONE = '   ';
    expect(defaultUsageLimits().resetTimezone).toBe('UTC');
  });

  it('uses a configured INSTANCE_TIMEZONE', () => {
    process.env.INSTANCE_TIMEZONE = 'Europe/Berlin';
    expect(defaultUsageLimits().resetTimezone).toBe('Europe/Berlin');
  });

  it('trims a configured INSTANCE_TIMEZONE', () => {
    process.env.INSTANCE_TIMEZONE = '  Europe/Berlin  ';
    expect(defaultUsageLimits().resetTimezone).toBe('Europe/Berlin');
  });

  it('prefers a non-blank explicit timezone argument over the environment', () => {
    process.env.INSTANCE_TIMEZONE = 'Europe/Berlin';
    expect(defaultUsageLimits('America/New_York').resetTimezone).toBe('America/New_York');
  });

  it('treats a blank explicit argument as absent (env, then UTC)', () => {
    delete process.env.INSTANCE_TIMEZONE;
    expect(defaultUsageLimits('   ').resetTimezone).toBe('UTC');
  });

  // The limit windows fall back to UTC on a zone `Intl` refuses, while Postgres
  // (backups, stats) errors on it or reads a bare offset with the opposite sign.
  it('seeds UTC for an INSTANCE_TIMEZONE that is unknown or a bare offset', () => {
    for (const zone of ['Europe/Berln', '+05:00', '-03:00']) {
      process.env.INSTANCE_TIMEZONE = zone;
      expect(defaultUsageLimits().resetTimezone).toBe('UTC');
    }
    process.env.INSTANCE_TIMEZONE = 'Etc/GMT+5';
    expect(defaultUsageLimits().resetTimezone).toBe('Etc/GMT+5');
  });

  it('carries the documented numeric defaults regardless of timezone', () => {
    delete process.env.INSTANCE_TIMEZONE;
    const limits = defaultUsageLimits();
    expect(limits.dailyGenerationTasks).toBe(DEFAULT_USAGE_LIMITS.dailyGenerationTasks);
    // Counted in provider calls, shown in Tracks: 25/125 calls is the 50 Tracks a
    // day and 250 a month the owner is offered, at Suno's 2 Tracks per call.
    expect(limits.dailyGenerationTasks).toBe(25);
    expect(limits.monthlyGenerationTasks).toBe(125);
    expect(limits.maxConcurrentJobs).toBe(1);
    expect(limits.maxQueuedTracks).toBe(6);
    expect(limits.storageQuotaBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(limits.manualGenerationOnly).toBe(false);
  });

  it('carries the Cover budget defaults, which count one for one', () => {
    delete process.env.INSTANCE_TIMEZONE;
    const limits = defaultUsageLimits();
    expect(limits.generatedCoversPerDay).toBe(25);
    expect(limits.generatedCoversPerMonth).toBe(100);
  });

  it('carries the idle auto-stop and creation-headroom defaults', () => {
    delete process.env.INSTANCE_TIMEZONE;
    const limits = defaultUsageLimits();
    // Renamed from idleAutoPauseAfterMinutes — the lifecycle auto-STOPS, never pauses.
    expect(limits.idleAutoStopAfterMinutes).toBe(15);
    // New: Start Session / More Like This require this much remaining headroom or
    // creation is blocked. Resume is never gated.
    expect(limits.minHeadroomTracksToStartSession).toBe(5);
  });
});

// The shipped defaults must sit under the shared ceilings the settings route and
// the Member/Pool schemas enforce — a default above one would be unsavable.
// `USAGE_LIMIT_CEILINGS` lives in `@liedmotif/shared`, which cannot see the
// `UsageLimits` type, so the uncast indexing below is also where a ceiling key
// that names no limit field stops compiling.
describe('DEFAULT_USAGE_LIMITS against the shared ceilings', () => {
  it('admits every shipped default', () => {
    for (const key of NUMERIC_LIMIT_KEYS) {
      expect(DEFAULT_USAGE_LIMITS[key]).toBeLessThanOrEqual(USAGE_LIMIT_CEILINGS[key]);
    }
  });
});
