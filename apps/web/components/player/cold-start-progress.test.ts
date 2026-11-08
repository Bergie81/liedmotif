// The cold-start staged-progress surface: what
// Now Playing narrates while the first track of a Session is still generating.
// Staged copy replaces the generic preparing/buffering text ONLY during a real
// cold start (preparing player, empty queue, healthy generation, a pending
// generation to narrate); banner states keep precedence by silencing it.

import { describe, expect, it } from 'vitest';
import type { PendingGeneration } from '@liedmotif/shared';
import {
  coldStartStagedCopy,
  EXPECTED_FIRST_STREAM_MS,
  resolveColdStartSurface,
  syntheticProgressFraction,
  type ColdStartSurface,
} from './cold-start-progress';

const PENDING: PendingGeneration = {
  stage: 'generating',
  submittedAt: '2026-07-01T10:00:00.000Z',
  trackTitle: null,
};

const COLD_START_BEGAN_AT = '2026-07-01T09:59:55.000Z';

function input(overrides: Partial<Parameters<typeof coldStartStagedCopy>[0]> = {}) {
  return {
    status: 'waiting' as const,
    queueLength: 0,
    generationStatus: 'ok' as const,
    statusMessageSafe: null,
    pendingGeneration: PENDING,
    coldStartBeganAt: COLD_START_BEGAN_AT,
    ...overrides,
  };
}

describe('coldStartStagedCopy', () => {
  it('narrates the backend stage while preparing with nothing playable', () => {
    // The narration carries its submit anchor: copy and bar timing exist only
    // together, so they travel as one value.
    expect(coldStartStagedCopy(input())).toEqual({
      copy: 'Composing your music…',
      submittedAt: PENDING.submittedAt,
    });
    expect(coldStartStagedCopy(input({ status: 'loading' }))?.copy).toBe('Composing your music…');
    expect(
      coldStartStagedCopy(input({ pendingGeneration: { ...PENDING, stage: 'submitting' } }))?.copy,
    ).toBe('Starting your session…');
    expect(
      coldStartStagedCopy(input({ pendingGeneration: { ...PENDING, stage: 'finalizing' } }))?.copy,
    ).toBe('Almost there — preparing your first track…');
  });

  it('is silent once the player carries or offers a track', () => {
    expect(coldStartStagedCopy(input({ status: 'ready' }))).toBeNull();
    expect(coldStartStagedCopy(input({ status: 'playing' }))).toBeNull();
    expect(coldStartStagedCopy(input({ queueLength: 2 }))).toBeNull();
  });

  it('yields to the generation-status banner (credits, rate limit, stall, error)', () => {
    for (const generationStatus of [
      'provider_credits',
      'provider_rate_limited',
      'worker_stalled',
      'provider_error',
      'repeat_cost_limit',
    ] as const) {
      expect(coldStartStagedCopy(input({ generationStatus }))).toBeNull();
    }
  });

  it('reads as connecting to the provider before the first pending generation arrives', () => {
    // Nothing has been polled yet, so the player surface's cold-start instant
    // anchors the synthetic bar.
    expect(coldStartStagedCopy(input({ pendingGeneration: null }))).toEqual({
      copy: 'Connecting to provider…',
      submittedAt: COLD_START_BEGAN_AT,
    });
  });

  it('keeps banner precedence and track silence for the connecting state too', () => {
    expect(
      coldStartStagedCopy(input({ pendingGeneration: null, generationStatus: 'worker_stalled' })),
    ).toBeNull();
    expect(coldStartStagedCopy(input({ pendingGeneration: null, queueLength: 1 }))).toBeNull();
    expect(coldStartStagedCopy(input({ pendingGeneration: null, status: 'ready' }))).toBeNull();
  });

  it('names the composing track when a teased title rides the pending generation', () => {
    expect(
      coldStartStagedCopy(input({ pendingGeneration: { ...PENDING, trackTitle: 'Neon Sunset' } }))
        ?.copy,
    ).toBe('Composing ‘Neon Sunset’…');
  });
});

// The synthetic bar is explicitly time-based (the provider exposes
// no real ETA): it fills against the expected stream-latency window, eases
// toward ~90%, and HOLDS there — only the real first-track arrival completes it.
describe('syntheticProgressFraction', () => {
  it('starts empty and clamps nonsense elapsed values', () => {
    expect(syntheticProgressFraction(0)).toBe(0);
    expect(syntheticProgressFraction(-5_000)).toBe(0);
    expect(syntheticProgressFraction(Number.NaN)).toBe(0);
  });

  it('rises monotonically through the expected window', () => {
    let previous = 0;
    for (let t = 0; t <= EXPECTED_FIRST_STREAM_MS * 2; t += 1_000) {
      const fraction = syntheticProgressFraction(t);
      expect(fraction).toBeGreaterThanOrEqual(previous);
      previous = fraction;
    }
  });

  it('is well past halfway by the end of the expected window', () => {
    expect(syntheticProgressFraction(EXPECTED_FIRST_STREAM_MS)).toBeGreaterThan(0.7);
  });

  it('never reaches 90% on its own, however long the generation runs', () => {
    for (const t of [EXPECTED_FIRST_STREAM_MS, EXPECTED_FIRST_STREAM_MS * 10, 3_600_000]) {
      expect(syntheticProgressFraction(t)).toBeLessThan(0.9);
    }
    // …but it holds NEAR the cap instead of stalling visibly early.
    expect(syntheticProgressFraction(EXPECTED_FIRST_STREAM_MS * 4)).toBeGreaterThan(0.85);
  });
});

describe('resolveColdStartSurface', () => {
  const NARRATION = { copy: 'Composing your music…', submittedAt: PENDING.submittedAt };
  const STAGED: ColdStartSurface = { kind: 'staged', ...NARRATION };
  const COMPLETE: ColdStartSurface = { kind: 'complete' };
  const NONE: ColdStartSurface = { kind: 'none' };

  it('shows the staged surface whenever staged copy is live', () => {
    expect(resolveColdStartSurface(NONE, NARRATION, false)).toEqual({
      kind: 'staged',
      ...NARRATION,
    });
  });

  it('completes the bar when the staged copy resolves into a playable track', () => {
    expect(resolveColdStartSurface(STAGED, null, true)).toEqual(COMPLETE);
    // The completion treatment holds until the component's timer ends it —
    // an intermediate re-render must not cut it short.
    expect(resolveColdStartSurface(COMPLETE, null, true)).toEqual(COMPLETE);
  });

  it('never fakes completion when the staged copy ends without a track (banner takeover)', () => {
    expect(resolveColdStartSurface(STAGED, null, false)).toEqual(NONE);
  });

  it('stays quiet in the steady playing state (no re-flash on later polls)', () => {
    expect(resolveColdStartSurface(NONE, null, true)).toEqual(NONE);
  });
});
