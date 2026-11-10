// @vitest-environment jsdom

// The app shell's player as the Assistant's commands reach it: the live
// controller, the provider's Sleep Timer, the player's Stop, and the audio
// unlock a sent message rides on.

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayerCommands } from './use-player-commands';

const SESSION_ID = '5d2f8e1b-6c3a-4f7e-8b9d-1a2b3c4d5e6f';

const player = vi.hoisted(() => ({ context: null as unknown }));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerContext: () => player.context,
}));
const navigation = vi.hoisted(() => ({ push: vi.fn<(path: string) => void>() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
const api = vi.hoisted(() => ({
  stopSession: vi.fn<(sessionId: string) => Promise<{ ok: boolean }>>(),
}));
vi.mock('@/lib/api-client', () => api);
const autoplay = vi.hoisted(() => ({ primePlayerAutoplay: vi.fn<() => void>() }));
vi.mock('@/components/player/autoplay-arm', () => autoplay);

/** A Session engaged and playing, or a Playlist when `session` is null. */
function engaged(session: { id: string } | null = { id: SESSION_ID }) {
  const controller = {
    status: 'playing',
    playIntentPending: false,
    playbackMode: 'loop-session',
    deckARef: { current: null },
    deckBRef: { current: null },
    play: vi.fn(),
    pause: vi.fn(),
    skip: vi.fn(),
    previous: vi.fn(),
    restart: vi.fn(),
    setPlaybackMode: vi.fn(),
  };
  const context = {
    playback: { session, player: controller },
    release: vi.fn(),
    sleepTimer: { endsAt: null, start: vi.fn(), cancel: vi.fn() },
  };
  player.context = context;
  return { controller, ...context };
}

beforeEach(() => {
  api.stopSession.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('the player, for the Assistant’s commands', () => {
  it('runs a command on the controller that is live when it arrives, not the one it was made with', async () => {
    engaged();
    const { result, rerender } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: false, refreshChrome: vi.fn() }),
    );
    const commands = result.current;
    const later = engaged();
    rerender();

    expect(await commands.run({ name: 'pause' })).toBe('done');
    expect(later.controller.pause).toHaveBeenCalledOnce();
    // One object for the life of the shell: the chat holds on to it.
    expect(result.current).toBe(commands);
  });

  it('sets and cancels the one Sleep Timer the player options show', async () => {
    const { sleepTimer } = engaged();
    const { result } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: false, refreshChrome: vi.fn() }),
    );

    await result.current.run({ name: 'sleepTimer', minutes: 45 });
    expect(sleepTimer.start).toHaveBeenCalledExactlyOnceWith(45);

    await result.current.run({ name: 'sleepTimerOff' });
    expect(sleepTimer.cancel).toHaveBeenCalledOnce();
  });

  it('stops the engaged Session as the player’s Stop does, and has the shell forget it', async () => {
    const { release } = engaged();
    const refreshChrome = vi.fn();
    const { result } = renderHook(() => usePlayerCommands({ onPlayerPage: false, refreshChrome }));

    expect(await result.current.run({ name: 'stop' })).toBe('done');

    expect(api.stopSession).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
    expect(release).toHaveBeenCalledOnce();
    expect(refreshChrome).toHaveBeenCalledOnce();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('leaves the Player for Sessions after a stop, as the Stop button does', async () => {
    engaged();
    const { result } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: true, refreshChrome: vi.fn() }),
    );

    await result.current.run({ name: 'stop' });

    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/sessions');
  });

  it('keeps the music when the stop was refused, and fails', async () => {
    const { release } = engaged();
    api.stopSession.mockResolvedValue({ ok: false });
    const { result } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: true, refreshChrome: vi.fn() }),
    );

    expect(await result.current.run({ name: 'stop' })).toBe('failed');
    expect(release).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('stops nothing while a Playlist plays: it has no Session to end', async () => {
    const { release } = engaged(null);
    const { result } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: false, refreshChrome: vi.fn() }),
    );

    expect(await result.current.run({ name: 'stop' })).toBe('failed');
    expect(api.stopSession).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('fails a command when nothing is engaged', async () => {
    player.context = {
      playback: null,
      release: vi.fn(),
      sleepTimer: { endsAt: null, start: vi.fn(), cancel: vi.fn() },
    };
    const { result } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: false, refreshChrome: vi.fn() }),
    );

    expect(await result.current.run({ name: 'continue' })).toBe('failed');
  });

  it('unlocks audio the way a Session start does when asked to prime', () => {
    engaged();
    const { result } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: false, refreshChrome: vi.fn() }),
    );

    result.current.prime();

    expect(autoplay.primePlayerAutoplay).toHaveBeenCalledOnce();
  });

  it('starts what is on the deck through the player’s own play for "Tap to play"', () => {
    const { controller } = engaged();
    const { result } = renderHook(() =>
      usePlayerCommands({ onPlayerPage: false, refreshChrome: vi.fn() }),
    );

    void result.current.tapToPlay();

    expect(controller.play).toHaveBeenCalledOnce();
  });
});
