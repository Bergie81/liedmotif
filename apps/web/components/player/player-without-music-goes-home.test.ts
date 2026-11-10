// @vitest-environment jsdom

// The Player page with no music to show: nothing engaged in this browser and
// no active Session on the server. It has nothing of its own to offer then, so
// it leaves for Home, where a Session starts.

import { createElement as h } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerView } from './player-view';

type Chrome = { ok: boolean; data?: { activeSession: { id: string } | null } };

const player = vi.hoisted(() => ({
  engage: vi.fn(),
  fetchChrome: vi.fn<() => Promise<Chrome>>(),
  refusal: null as unknown,
}));
vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    engagedSource: null,
    playback: null,
    pending: null,
    engage: player.engage,
    release: vi.fn(),
  }),
}));
vi.mock('./session-handoff', () => ({
  cancelPendingStart: vi.fn(),
  currentPendingStart: () => null,
  takeUnshownStartRefusal: () => player.refusal,
}));
vi.mock('@/components/app-chrome-context', () => ({
  useAppChrome: () => ({ fetchChrome: player.fetchChrome }),
}));
const router = vi.hoisted(() => ({
  push: vi.fn<(path: string) => void>(),
  replace: vi.fn<(path: string) => void>(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  player.refusal = null;
});

describe('the Player page with no music to show', () => {
  it('leaves for Home in place of an empty player', async () => {
    player.fetchChrome.mockResolvedValue({ ok: true, data: { activeSession: null } });

    render(h(PlayerView));

    await waitFor(() => expect(router.replace).toHaveBeenCalledExactlyOnceWith('/'));
    expect(screen.queryByText('Nothing playing')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('stays, with the active Session, when the server has one', async () => {
    const session = { id: '5d2f8e1b-6c3a-4f7e-8b9d-1a2b3c4d5e6f' };
    player.fetchChrome.mockResolvedValue({ ok: true, data: { activeSession: session } });

    render(h(PlayerView));

    await waitFor(() => expect(player.engage).toHaveBeenCalledWith(session, { autoplay: false }));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says why a Start was refused before it leaves, over no empty player', () => {
    player.refusal = {
      ok: false,
      error: { code: 'session_headroom_blocked', message: 'Your daily limit is used up.' },
    };

    render(h(PlayerView));

    expect(screen.getByText('Your daily limit is used up.')).toBeTruthy();
    expect(screen.queryByText('Nothing playing')).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
