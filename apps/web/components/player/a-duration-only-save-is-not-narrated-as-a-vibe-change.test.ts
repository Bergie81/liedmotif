// @vitest-environment jsdom

// The Change Vibe sheet also saves a Session's duration on its own. Both
// requests hold the same gate, but only a new vibe is a change of direction:
// the player narrates one and stays quiet through the other.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useVibeChangeRequest } from './use-vibe-change-request';

const NEVER_SETTLES = new Promise(() => undefined);

vi.mock('@/lib/http/api-client', () => ({
  changeVibe: () => NEVER_SETTLES,
  setSessionDuration: () => NEVER_SETTLES,
}));

afterEach(cleanup);

const INPUT = { mode: 'prompt', prompt: 'rainy jazz' } as never;

it('marks a request for a new vibe as restyling the Session', () => {
  const { result } = renderHook(() => useVibeChangeRequest(vi.fn()));

  act(() => void result.current.submitChangeVibe('session-1', INPUT, {}));

  expect(result.current.vibeChange).toMatchObject({
    pendingSessionId: 'session-1',
    restyling: true,
  });
});

it('holds the gate for a duration-only save without calling it a restyle', () => {
  const { result } = renderHook(() => useVibeChangeRequest(vi.fn()));

  act(
    () =>
      void result.current.submitChangeVibe('session-1', undefined, { targetDurationMinutes: 90 }),
  );

  expect(result.current.vibeChange).toMatchObject({
    pendingSessionId: 'session-1',
    restyling: false,
  });
  // The gate still drops a second submit while the save is in flight.
  expect(result.current.submitChangeVibe('session-1', INPUT, {})).toBeNull();
});
