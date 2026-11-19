// @vitest-environment jsdom

// A failure on the Player belongs to the music it happened on. When another
// source takes the player over, what the old one reported goes with it.

import { createElement as h } from 'react';
import type { PlaylistSummaryItem, SessionSummary } from '@liedmotif/shared';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';

const api = vi.hoisted(() => ({ changeVibe: vi.fn() }));

vi.mock('@/lib/http/api-client', async (original) => ({
  ...(await original<typeof import('@/lib/http/api-client')>()),
  changeVibe: api.changeVibe,
}));
const controller = vi.hoisted(() => ({
  status: 'idle',
  sessionStatus: 'active',
  blendSettled: true,
  blendEnabled: true,
  deckARef: { current: null },
  deckBRef: { current: null },
  refreshQueue: () => undefined,
  pause: () => undefined,
  setOutputVolume: () => undefined,
}));
vi.mock('./use-playback-controller', () => ({ usePlaybackController: () => controller }));

const { PlayerProvider, usePlayerActions } = await import('./player-provider');

afterEach(() => {
  cleanup();
  toast.dismiss();
});

const SESSION = { id: 'session-1', status: 'active' } as SessionSummary;
const PLAYLIST = { id: 'playlist-1', name: 'Focus Nights' } as PlaylistSummaryItem;

let actions: ReturnType<typeof usePlayerActions>;
function Grab() {
  actions = usePlayerActions();
  return null;
}

it('closes the old Session’s failures when a Playlist takes the player over', async () => {
  api.changeVibe.mockResolvedValueOnce({ ok: false, error: { message: 'Offline.' } });
  render(h(PlayerProvider, null, h(Grab)));
  act(() => actions.engage(SESSION, { autoplay: true }));
  await act(async () => {
    await actions.submitChangeVibe(SESSION.id, { mode: 'prompt', prompt: 'rain' } as never, {});
  });
  expect(shownToasts().map((shown) => shown.message)).toEqual(['Change Vibe failed: Offline.']);

  act(() => actions.engagePlaylist(PLAYLIST, []));

  expect(shownToasts()).toEqual([]);
});
