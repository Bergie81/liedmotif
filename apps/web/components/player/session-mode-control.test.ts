// @vitest-environment jsdom

import { createElement as h, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMode } from '@liedmotif/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionModeToggleButton, SessionModeToggleTile } from './session-mode-control';
import { useSessionModeToggle } from './use-session-mode-toggle';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Controls({
  showTile = true,
  initialMode = 'repeat',
}: {
  showTile?: boolean;
  initialMode?: SessionMode;
}) {
  const [sessionMode, setMode] = useState(initialMode);
  const [error, setError] = useState<string | null>(null);
  const toggle = useSessionModeToggle({
    sessionId: '00000000-0000-4000-8000-000000000001',
    sessionMode,
    available: true,
    onSessionChange: (session) => setMode(session.sessionMode),
    onError: setError,
  });
  return h(
    TooltipProvider,
    null,
    h(SessionModeToggleButton, toggle),
    showTile ? h(SessionModeToggleTile, toggle) : null,
    error ? h('p', { role: 'alert' }, error) : null,
  );
}

describe('shared Session mode controls', () => {
  it('keeps the visible tooltip short while the accessible label explains activation', async () => {
    vi.useFakeTimers();
    const view = render(h(Controls));
    const button = view.getByTestId('player-session-mode-toggle');
    act(() => button.focus());
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(view.getByRole('tooltip').textContent).toBe('Play existing Tracks');
    expect(button.getAttribute('aria-label')).toContain('after five seconds');
  });

  it.each([true, false])(
    'shows confirmed activation only after a successful response (success: %s)',
    async (success) => {
      vi.useFakeTimers();
      let respond: (body: unknown) => void = () => {};
      vi.stubGlobal(
        'fetch',
        () =>
          new Promise((resolve) => {
            respond = (body) => resolve({ json: async () => body });
          }),
      );
      const view = render(h(Controls));
      const header = view.getByTestId('player-session-mode-toggle') as HTMLButtonElement;
      act(() => header.click());
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(header.getAttribute('aria-pressed')).toBe('false');
      expect(header.disabled).toBe(true);
      await act(async () =>
        respond(
          success
            ? {
                ok: true,
                data: {
                  session: {
                    id: '00000000-0000-4000-8000-000000000001',
                    status: 'active',
                    title: 'Night',
                    sessionMode: 'keep_going',
                    generationStatus: 'ok',
                    generationStatusScope: null,
                    coverImageId: null,
                    statusMessageSafe: null,
                    createdAt: '2026-09-12T20:00:00.000Z',
                    updatedAt: '2026-09-12T20:00:00.000Z',
                  },
                },
              }
            : {
                ok: false,
                error: {
                  code: 'internal_error',
                  message: 'Mode change failed.',
                  retryable: true,
                },
              },
        ),
      );
      expect(header.getAttribute('aria-pressed')).toBe(String(success));
      expect(header.disabled).toBe(false);
      expect(view.getByTestId('player-session-mode-menu-toggle').getAttribute('aria-pressed')).toBe(
        String(success),
      );
      if (!success) expect(view.getByRole('alert').textContent).toBe('Mode change failed.');
    },
  );

  it.each(['player-session-mode-toggle', 'player-session-mode-menu-toggle'])(
    'can cancel activation from %s through the other control',
    async (startingControl) => {
      vi.useFakeTimers();
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const view = render(h(Controls));
      const header = view.getByTestId('player-session-mode-toggle');
      const tile = view.getByTestId('player-session-mode-menu-toggle');
      expect(header.querySelector('mask')).not.toBeNull();
      act(() => view.getByTestId(startingControl).click());
      for (const control of [header, tile]) {
        expect(control.getAttribute('aria-pressed')).toBe('false');
        expect(control.getAttribute('aria-label')).toMatch(/cancel/i);
        expect(control.querySelector('.animate-pulse')).not.toBeNull();
        expect(control.querySelector('mask')).toBeNull();
        expect(control.textContent).not.toMatch(/starting|5s/i);
      }
      await act(() => vi.advanceTimersByTimeAsync(4000));
      act(() => (startingControl === header.dataset.testid ? tile : header).click());
      await act(() => vi.advanceTimersByTimeAsync(10000));
      expect(fetch).not.toHaveBeenCalled();
      expect(header.querySelector('mask')).not.toBeNull();
      expect(tile.querySelector('.animate-pulse')).toBeNull();
    },
  );

  it('preserves the activation deadline when options close and reopen', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const view = render(h(Controls));
    act(() => view.getByTestId('player-session-mode-menu-toggle').click());
    await act(() => vi.advanceTimersByTimeAsync(2000));
    view.rerender(h(Controls, { showTile: false }));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    view.rerender(h(Controls));
    expect(
      view.getByTestId('player-session-mode-menu-toggle').querySelector('.animate-pulse'),
    ).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requests Repeat immediately and keeps the confirmed mode when the write fails', async () => {
    const fetch = vi.fn(async () => ({
      json: async () => ({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Mode change failed.',
          retryable: true,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetch);
    const view = render(h(Controls, { initialMode: 'keep_going' }));
    await act(async () => view.getByTestId('player-session-mode-toggle').click());
    expect(fetch.mock.calls[0]).toMatchObject([
      '/api/sessions/mode',
      {
        body: JSON.stringify({ sessionId: '00000000-0000-4000-8000-000000000001', mode: 'repeat' }),
      },
    ]);
    expect(view.getByTestId('player-session-mode-toggle').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(view.getByRole('alert').textContent).toBe('Mode change failed.');
    fetch.mockImplementationOnce(() => new Promise(() => {}));
    act(() => view.getByTestId('player-session-mode-toggle').click());
    expect(view.queryByRole('alert')).toBeNull();
  });
});
