// @vitest-environment jsdom

// A Start can begin while /player is already on screen (a Start card confirmed
// in the Assistant there): the navigation to /player keeps the page mounted, so
// the page must still narrate that Start with its Cancel, show its refusal
// there, and leave no refusal behind for a later, unrelated visit.

import { createElement as h } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlayerView } from './player-view';
import { beginPendingStart, cancelPendingStart, type PendingStart } from './session-handoff';

const player = vi.hoisted(() => ({
  startCount: 0,
  engage: vi.fn(),
  release: vi.fn(),
  fetchChrome: vi.fn(() => new Promise(() => undefined)),
}));

const PLAYLIST = { id: '11111111-1111-4111-8111-111111111111', name: 'Focus Nights' };
const SOURCE = { kind: 'playlist', playlist: PLAYLIST };

vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    engagedSource: SOURCE,
    playback: { session: null, source: SOURCE },
    pending: null,
    startCount: player.startCount,
    engage: player.engage,
    release: player.release,
  }),
}));
vi.mock('./playlist-now-playing', () => ({
  PlaylistNowPlaying: () => h('div', { 'data-testid': 'live-player' }),
}));
vi.mock('@/components/create/creation-blocked-dialog', () => ({
  CreationBlockedDialog: ({ refusal }: { refusal: { message: string } }) =>
    h('div', { 'data-testid': 'blocked-dialog' }, refusal.message),
}));
vi.mock('@/components/app-chrome-context', () => ({
  useAppChrome: () => ({ fetchChrome: player.fetchChrome }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

afterEach(() => {
  cleanup();
  cancelPendingStart();
  player.startCount = 0;
});

it('narrates and refuses a Start begun while the player is mounted', async () => {
  const view = render(h(PlayerView));
  let settle: (result: Awaited<PendingStart['result']>) => void = () => {};

  act(() => {
    beginPendingStart(
      () => {
        player.startCount += 1;
        return new Promise((resolve) => (settle = resolve));
      },
      () => undefined,
    );
  });
  view.rerender(h(PlayerView));

  expect(screen.queryByTestId('cancel-start')).not.toBeNull();

  await act(async () =>
    settle({
      ok: false,
      error: { code: 'session_headroom_blocked', message: 'Daily limit reached.' },
    } as Awaited<PendingStart['result']>),
  );

  expect(screen.getByTestId('blocked-dialog').textContent).toContain('Daily limit reached.');

  cleanup();
  render(h(PlayerView));

  expect(screen.queryByTestId('blocked-dialog')).toBeNull();
});
