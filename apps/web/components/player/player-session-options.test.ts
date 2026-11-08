// @vitest-environment jsdom

import { createElement as h, useState } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlayerSessionOptions } from './player-session-options';
import { useSessionModeToggle } from './use-session-mode-toggle';

// Lazily loaded and needs the app shell: left real, it throws whenever its import
// settles before the test ends, which makes these tests depend on load timing.
vi.mock('./regenerate-cover-dialog', () => ({ RegenerateCoverDialog: () => null }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Options({
  changeVibeAvailable = true,
  onConvertToPlaylist = () => {},
}: {
  changeVibeAvailable?: boolean;
  onConvertToPlaylist?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const modeToggle = useSessionModeToggle({
    sessionId: 'session-1',
    sessionMode: 'repeat',
    available: true,
    onSessionChange: () => {},
    onError: setError,
  });
  const noop = () => {};
  const succeed = async () => null;
  const complete = async () => {};
  return h(PlayerSessionOptions, {
    sessionId: 'session-1',
    sessionTitle: 'Night',
    coverImageId: null,
    modeToggle,
    actionError: error,
    busy: false,
    onStop: noop,
    lyricsAvailable: false,
    onOpenLyrics: noop,
    onOpenTrackData: noop,
    track: null,
    onConvertToPlaylist,
    onRenameSession: succeed,
    onRenameTrack: succeed,
    onReroll: noop,
    onMoreLikeThis: complete,
    onOpenChangeVibe: noop,
    changeVibeAvailable,
    onDeleteTrack: complete,
    onDeleteSession: complete,
    blendEnabled: true,
    onToggleBlend: noop,
    onAddTrackToPlaylist: noop,
    sleepTimerEndsAt: null,
    sectionLoop: { open: false, available: true, onToggle: () => {} },
  });
}

it('reports refused activation inside the still-open options dialog', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', async () => ({
    json: async () => ({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Mode change failed.',
        retryable: true,
      },
    }),
  }));
  render(h(Options));
  act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());
  act(() => screen.getByTestId('player-session-mode-menu-toggle').click());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('alert').textContent).toBe('Mode change failed.');
  expect(
    within(dialog).getByTestId('player-session-mode-menu-toggle').getAttribute('aria-pressed'),
  ).toBe('false');
});

it('offers Convert to Playlist with no current Track, as after a reload before play', () => {
  const onConvertToPlaylist = vi.fn();
  render(h(Options, { onConvertToPlaylist }));
  act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());
  act(() => screen.getByTestId('player-convert-session-to-playlist').click());
  expect(onConvertToPlaylist).toHaveBeenCalledOnce();
});

it('keeps Change Vibe unavailable while the player says so', () => {
  render(h(Options, { changeVibeAvailable: false }));
  act(() => screen.getByRole('button', { name: 'Session and Track options' }).click());
  expect((screen.getByTestId('player-options-change-vibe') as HTMLButtonElement).disabled).toBe(
    true,
  );
});
