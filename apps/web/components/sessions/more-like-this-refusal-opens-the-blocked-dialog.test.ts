// @vitest-environment jsdom

// A More Like This refused for lack of headroom must reach its caller as that
// refusal, code and all, so the caller can offer the blocked dialog's ways out
// instead of a line of error text. No Session is engaged and nothing navigates.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSeedMoreLikeThis } from './use-seed-more-like-this';

const player = vi.hoisted(() => ({ engage: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: player.push }) }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerActions: () => ({ engage: player.engage, beginOtherMusic: async () => true }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('hands a headroom refusal to the caller with its error code', async () => {
  const message = 'A new session needs 5 tracks; you have 4 left today.';
  vi.stubGlobal('fetch', async () => ({
    json: async () => ({
      ok: false,
      error: { code: 'session_headroom_blocked', message, retryable: false },
    }),
  }));
  const { result } = renderHook(() => useSeedMoreLikeThis());

  let outcome: Awaited<ReturnType<ReturnType<typeof useSeedMoreLikeThis>>> | undefined;
  await act(async () => {
    outcome = await result.current({ seedTrackIds: ['track-1'] });
  });

  expect(outcome).toEqual({
    started: false,
    refusal: { code: 'session_headroom_blocked', message },
  });
  expect(player.engage).not.toHaveBeenCalled();
  expect(player.push).not.toHaveBeenCalled();
});
