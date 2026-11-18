// @vitest-environment jsdom

// A Change Vibe that did not land says so once, when it fails, wherever the
// listener is; trying again takes the failure away.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { useVibeChangeRequest } from './use-vibe-change-request';

const api = vi.hoisted(() => ({ changeVibe: vi.fn() }));

vi.mock('@/lib/api-client', () => ({
  changeVibe: api.changeVibe,
  setSessionDuration: vi.fn(),
}));

afterEach(() => {
  cleanup();
  toast.dismiss();
  api.changeVibe.mockReset();
});

const INPUT = { mode: 'prompt', prompt: 'rainy jazz' } as never;

const shownErrors = () =>
  shownToasts().flatMap((shown) => (shown.tone === 'error' ? [shown.message] : []));

it('shows a refused Change Vibe as it fails, and drops it when it is tried again', async () => {
  api.changeVibe.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
  api.changeVibe.mockReturnValueOnce(new Promise(() => undefined));
  const { result } = renderHook(() => useVibeChangeRequest(vi.fn()));

  await act(async () => {
    await result.current.submitChangeVibe('session-1', INPUT, {});
  });
  expect(shownErrors()).toEqual(['Change Vibe failed: Offline.']);

  act(() => void result.current.submitChangeVibe('session-1', INPUT, {}));

  expect(shownErrors()).toEqual([]);
});
