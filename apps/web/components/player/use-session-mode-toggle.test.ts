// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMode } from '@liedmotif/shared';
import { useSessionModeToggle } from './use-session-mode-toggle';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Session mode activation', () => {
  it('does not report a late write failure onto a different Session', async () => {
    let respond: (body: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise((resolve) => {
          respond = (body) => resolve({ json: async () => body });
        }),
    );
    const initialProps = {
      sessionId: 'session-1',
      sessionMode: 'keep_going' as SessionMode,
      available: true,
      onSessionChange: vi.fn(),
      onError: vi.fn(),
    };
    const { result, rerender } = renderHook(useSessionModeToggle, { initialProps });
    act(() => result.current.onToggle());
    rerender({ ...initialProps, sessionId: 'session-2' });
    await act(async () =>
      respond({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Write failed.',
          retryable: true,
        },
      }),
    );
    expect(initialProps.onError).not.toHaveBeenCalledWith('Write failed.');
    expect(initialProps.onSessionChange).not.toHaveBeenCalled();
  });

  it.each(['hidden', 'pagehide', 'session', 'unavailable', 'external mode', 'unmount'])(
    'discards pending activation on %s without restarting when returning',
    async (reason) => {
      vi.useFakeTimers();
      const fetch = vi.fn(() => new Promise(() => {}));
      vi.stubGlobal('fetch', fetch);
      const initialProps = {
        sessionId: 'session-1',
        sessionMode: 'repeat' as SessionMode,
        available: true,
        onSessionChange: vi.fn(),
        onError: vi.fn(),
      };
      const { result, rerender, unmount } = renderHook(useSessionModeToggle, { initialProps });
      act(() => result.current.onToggle());
      await act(() => vi.advanceTimersByTimeAsync(4000));

      if (reason === 'hidden') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        vi.restoreAllMocks();
        act(() => document.dispatchEvent(new Event('visibilitychange')));
      } else if (reason === 'pagehide') {
        act(() => window.dispatchEvent(new Event('pagehide')));
      } else if (reason === 'unmount') {
        unmount();
      } else {
        rerender({
          ...initialProps,
          ...(reason === 'session' ? { sessionId: 'session-2' } : {}),
          ...(reason === 'unavailable' ? { available: false } : {}),
          ...(reason === 'external mode' ? { sessionMode: 'keep_going' as const } : {}),
        });
        rerender(initialProps);
      }
      await act(() => vi.advanceTimersByTimeAsync(10000));
      expect(fetch).not.toHaveBeenCalled();
      if (reason !== 'unmount') expect(result.current.pending).toBe(false);
    },
  );

  it('keeps generation off for five seconds before sending one activation request', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() =>
      useSessionModeToggle({
        sessionId: 'session-1',
        sessionMode: 'repeat',
        available: true,
        onSessionChange: vi.fn(),
        onError: vi.fn(),
      }),
    );

    act(() => result.current.onToggle());
    expect(result.current.pending).toBe(true);
    expect(result.current.sessionMode).toBe('repeat');
    await act(() => vi.advanceTimersByTimeAsync(4999));
    expect(fetch).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toMatchObject([
      '/api/sessions/mode',
      { method: 'POST', body: JSON.stringify({ sessionId: 'session-1', mode: 'keep_going' }) },
    ]);
    expect(result.current.pending).toBe(false);
    expect(result.current.disabled).toBe(true);
  });
});
