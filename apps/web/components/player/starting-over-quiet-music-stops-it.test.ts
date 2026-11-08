// @vitest-environment jsdom

// A Start over music that is not playing (paused, ended, waiting on its next
// Track) stops that music first: /player then narrates the new Session the
// same way it does with nothing engaged, never a stale paused player. Music
// that is actually playing keeps going until the new Session is ready.

import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@liedmotif/shared';

const fakeController = vi.hoisted(() => ({
  status: 'paused',
  sessionStatus: 'active',
  blendSettled: true,
  blendEnabled: true,
  deckARef: { current: null },
  deckBRef: { current: null },
  refreshQueue: () => undefined,
  pause: () => undefined,
  setOutputVolume: () => undefined,
}));

vi.mock('./use-playback-controller', () => ({
  usePlaybackController: () => fakeController,
}));

const { PlayerProvider, usePlayerContext } = await import('./player-provider');

const old = { id: 'old-session', title: 'Old' } as SessionSummary;

function engagedOver(status: string) {
  fakeController.status = status;
  let player!: ReturnType<typeof usePlayerContext>;
  function Probe() {
    player = usePlayerContext();
    return null;
  }
  render(createElement(PlayerProvider, null, createElement(Probe)));
  act(() => player.engage(old));
  return () => player;
}

describe('starting over quiet music', () => {
  afterEach(cleanup);

  it.each(['loading', 'ready', 'paused', 'waiting', 'ended'])('stops %s music', (status) => {
    const player = engagedOver(status);
    act(() => player().beginStart());
    expect(player().engagedSource).toBeNull();
  });

  it('keeps playing music engaged', () => {
    const player = engagedOver('playing');
    act(() => player().beginStart());
    expect(player().engagedSource).not.toBeNull();
  });
});
