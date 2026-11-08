// @vitest-environment jsdom

// A refused Start lands on /player, where the mini player is hidden: while the
// music already playing keeps going, its full player must stay on screen under
// the "didn't start" card, or that music has no controls at all.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerView } from './player-view';

const player = vi.hoisted(() => ({
  engagedSource: null as unknown,
  playback: null as unknown,
  engage: vi.fn(),
  release: vi.fn(),
  fetchChrome: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    engagedSource: player.engagedSource,
    playback: player.playback,
    pending: null,
    engage: player.engage,
    release: player.release,
  }),
}));
vi.mock('./playlist-now-playing', () => ({
  PlaylistNowPlaying: () => h('div', { 'data-testid': 'live-player' }),
}));
vi.mock('./session-handoff', () => ({
  cancelPendingStart: vi.fn(),
  currentPendingStart: () => null,
  takeUnshownStartRefusal: () => ({
    ok: false,
    error: { code: 'provider_error', message: 'The music model is unreachable.' },
  }),
}));
vi.mock('@/components/app-chrome-context', () => ({
  useAppChrome: () => ({ fetchChrome: player.fetchChrome }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  player.engagedSource = null;
  player.playback = null;
});

const PLAYLIST = { id: '11111111-1111-4111-8111-111111111111', name: 'Focus Nights' };

describe('PlayerView — a failed Start', () => {
  it('keeps the live player under the error card while another source plays', () => {
    const source = { kind: 'playlist', playlist: PLAYLIST };
    player.engagedSource = source;
    player.playback = { session: null, source };
    render(h(PlayerView));

    expect(screen.getByRole('alert').textContent).toContain('The music model is unreachable.');
    expect(screen.getByTestId('live-player')).toBeTruthy();
  });

  it('shows the error card alone when nothing is engaged', () => {
    render(h(PlayerView));

    expect(screen.getByRole('alert').textContent).toContain('Your Session didn’t start');
    expect(screen.queryByTestId('live-player')).toBeNull();
  });
});
