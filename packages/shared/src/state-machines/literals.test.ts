import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_SESSION_STATUSES,
  PROVIDER_NORMALIZED_STATUSES,
  QUEUE_ITEM_STATES,
  SESSION_END_REASONS,
  SESSION_GENERATION_STATUSES,
  SESSION_MODES,
  SESSION_REPEAT_GENERATION_STATUSES,
  TRACK_STATUSES,
  assertTrackUserStateInvariants,
  deriveTrackRetentionClass,
  isFlagSet,
  isSessionRepeatGenerationStatus,
} from './literals';

describe('state literals', () => {
  it('declares each machine in a stable, duplicate-free order', () => {
    for (const values of [
      ACTIVITY_SESSION_STATUSES,
      QUEUE_ITEM_STATES,
      PROVIDER_NORMALIZED_STATUSES,
      TRACK_STATUSES,
      SESSION_END_REASONS,
      SESSION_GENERATION_STATUSES,
      SESSION_MODES,
    ]) {
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

// The literal value domains themselves are covered elsewhere, against the live
// column enums.
describe('session value domains', () => {
  it('the Session-Repeat statuses are exactly the two "no new tracks are coming" cases', () => {
    // The worker↔player contract: under these the player loops the session's own
    // set instead of waiting at the end of the queue.
    expect([...SESSION_REPEAT_GENERATION_STATUSES]).toEqual([
      'repeat_cost_limit',
      'repeat_buffer_complete',
    ]);
    expect(isSessionRepeatGenerationStatus('repeat_buffer_complete')).toBe(true);
    expect(isSessionRepeatGenerationStatus('ok')).toBe(false);
    expect(isSessionRepeatGenerationStatus('provider_error')).toBe(false);
  });
});

describe('isFlagSet', () => {
  it('is true only for non-null, non-undefined timestamps', () => {
    expect(isFlagSet(new Date())).toBe(true);
    expect(isFlagSet('2026-06-28')).toBe(true);
    expect(isFlagSet(0)).toBe(true);
    expect(isFlagSet(null)).toBe(false);
    expect(isFlagSet(undefined)).toBe(false);
  });
});

describe('deriveTrackRetentionClass precedence', () => {
  const now = new Date();

  it('is ephemeral when nothing is set', () => {
    expect(deriveTrackRetentionClass({ savedAt: null, favoritedAt: null, dislikedAt: null })).toBe(
      'ephemeral',
    );
  });

  it('is durable when saved (or favorited, which implies saved)', () => {
    expect(deriveTrackRetentionClass({ savedAt: now, favoritedAt: null, dislikedAt: null })).toBe(
      'durable',
    );
    expect(deriveTrackRetentionClass({ savedAt: now, favoritedAt: now, dislikedAt: null })).toBe(
      'durable',
    );
  });

  it('is reject when disliked, even if previously saved (Reject wins)', () => {
    expect(deriveTrackRetentionClass({ savedAt: now, favoritedAt: null, dislikedAt: now })).toBe(
      'reject',
    );
  });
});

describe('assertTrackUserStateInvariants', () => {
  const now = new Date();

  it('accepts favoritedAt only when savedAt is also set', () => {
    expect(() =>
      assertTrackUserStateInvariants({ savedAt: now, favoritedAt: now, dislikedAt: null }),
    ).not.toThrow();
  });

  it('rejects favoritedAt without savedAt (Favorite implies Save)', () => {
    expect(() =>
      assertTrackUserStateInvariants({ savedAt: null, favoritedAt: now, dislikedAt: null }),
    ).toThrow(/Favorite implies Save/);
  });
});
