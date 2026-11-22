// @vitest-environment jsdom

// While a Start is still setting up, More Like This first asks whether to
// replace it. A "no" starts nothing, and the caller must hear that nothing
// started: a sheet that took it for a start would close and drop the words the
// user typed. It is no refusal either, so there is nothing to report.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSeedMoreLikeThis } from './use-seed-more-like-this';

const player = vi.hoisted(() => ({ engage: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: player.push }) }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({ engage: player.engage, beginOtherMusic: async () => false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('reports a declined replace question as not started and not refused', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useSeedMoreLikeThis());

  let outcome: Awaited<ReturnType<ReturnType<typeof useSeedMoreLikeThis>>> | undefined;
  await act(async () => {
    outcome = await result.current(['track-1'], undefined, 'for cooking');
  });

  expect(outcome).toEqual({ started: false, refusal: null });
  expect(fetch).not.toHaveBeenCalled();
  expect(player.engage).not.toHaveBeenCalled();
  expect(player.push).not.toHaveBeenCalled();
});
