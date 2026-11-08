// The completed-onboarding memo: only `true` is process-cached (the state is
// monotonic); incomplete always re-reads, and the completion route primes the
// memo without waiting for the next read.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: vi.fn(async () => ({ completedAt: null as string | null })),
}));
vi.mock('@liedmotif/db', () => ({ getOnboardingState: mocks.state }));

const { hasCompletedOnboarding, markOnboardingComplete, resetOnboardingMemoForTests } =
  await import('./onboarding-memo');

const db = {} as never;

describe('onboarding completion memo', () => {
  beforeEach(() => {
    resetOnboardingMemoForTests();
    mocks.state.mockClear();
    mocks.state.mockResolvedValue({ completedAt: null });
  });

  it('incomplete: re-reads on every check and stays false', async () => {
    expect(await hasCompletedOnboarding(db, 'u1')).toBe(false);
    expect(await hasCompletedOnboarding(db, 'u1')).toBe(false);
    expect(mocks.state).toHaveBeenCalledTimes(2);
  });

  it('completed: the first read primes the memo; later checks skip the query', async () => {
    mocks.state.mockResolvedValue({ completedAt: '2026-07-25T09:00:00.000Z' });
    expect(await hasCompletedOnboarding(db, 'u1')).toBe(true);
    expect(await hasCompletedOnboarding(db, 'u1')).toBe(true);
    expect(mocks.state).toHaveBeenCalledTimes(1);
  });

  it('markOnboardingComplete primes the memo without a query, per user', async () => {
    markOnboardingComplete('u1');
    expect(await hasCompletedOnboarding(db, 'u1')).toBe(true);
    expect(mocks.state).not.toHaveBeenCalled();
    // Another user is unaffected by u1's completion.
    expect(await hasCompletedOnboarding(db, 'u2')).toBe(false);
    expect(mocks.state).toHaveBeenCalledTimes(1);
  });
});
