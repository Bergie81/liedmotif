// @vitest-environment jsdom

// A refused Start lands on /player, where the mini player is hidden: while the
// music already playing keeps going, its full player must stay on screen under
// the "didn't start" card, or that music has no controls at all.

import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerView } from './player-view';

const handoff = vi.hoisted(() => ({ refusal: null as unknown }));

const player = vi.hoisted(() => ({
  engagedSource: null as unknown,
  playback: null as unknown,
  pending: null as unknown,
  engage: vi.fn(),
  release: vi.fn(),
  fetchChrome: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    engagedSource: player.engagedSource,
    playback: player.playback,
    pending: player.pending,
    engage: player.engage,
    release: player.release,
  }),
}));
vi.mock('./playlist-now-playing', () => ({
  PlaylistNowPlaying: ({ incoming }: { incoming?: unknown }) =>
    h('div', { 'data-testid': 'live-player', 'data-incoming': JSON.stringify(incoming ?? null) }),
}));
vi.mock('./session-handoff', () => ({
  cancelPendingStart: vi.fn(),
  currentPendingStart: () => null,
  takeUnshownStartRefusal: () => handoff.refusal,
}));
vi.mock('@/components/app-chrome-context', () => ({
  useAppChrome: () => ({ fetchChrome: player.fetchChrome }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  player.engagedSource = null;
  player.playback = null;
  player.pending = null;
});

const PLAYLIST = { id: '11111111-1111-4111-8111-111111111111', name: 'Focus Nights' };

describe('PlayerView — a failed Start', () => {
  beforeEach(() => {
    handoff.refusal = {
      ok: false,
      error: { code: 'provider_error', message: 'The music model is unreachable.' },
    };
  });

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

    expect(screen.getByRole('alert').textContent).toContain('Your Session Didn’t Start');
    expect(screen.queryByTestId('live-player')).toBeNull();
  });
});

describe('PlayerView — a Session prepared behind a Playlist', () => {
  it('hands the Playlist player the incoming Session after its start succeeded', () => {
    handoff.refusal = null;
    const source = { kind: 'playlist', playlist: PLAYLIST };
    player.engagedSource = source;
    player.playback = { session: null, source };
    player.pending = {
      source: { kind: 'session', session: { id: 'session-2', title: 'Night Drive' } },
      player: { generationStatus: 'ok' },
    };
    render(h(PlayerView));

    expect(JSON.parse(screen.getByTestId('live-player').dataset.incoming!)).toEqual({
      noun: 'Session',
      title: 'Night Drive',
    });
  });
});
