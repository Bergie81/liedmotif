// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlaySessionTrack } from './use-play-session-track';

const sessionId = '00000000-0000-4000-8000-000000000001';
const trackId = '00000000-0000-4000-8000-000000000002';
const context = vi.hoisted(() => ({
  playback: {
    session: { id: '00000000-0000-4000-8000-000000000001' } as { id: string } | null,
    player: {
      currentTrack: { trackId: 'current' },
      queueItems: [] as { id: string; trackId: string }[],
      playableQueueItemIds: [] as string[],
      status: 'playing',
      toggle: vi.fn(),
      playQueueItem: vi.fn(),
      refreshQueue: vi.fn(),
    },
  },
  playlistId: 'playlist-a',
  released: false,
  pendingPlaylistId: null as string | null,
  engage: vi.fn(),
  beginOtherMusic: async () => true,
}));
vi.mock('./player-provider', () => ({
  usePlayerContext: () => ({
    ...context,
    playback: context.released ? null : context.playback,
    engagedSource: context.released
      ? null
      : context.playback.session
        ? { kind: 'session', session: context.playback.session }
        : { kind: 'playlist', playlist: { id: context.playlistId } },
    pending: context.pendingPlaylistId
      ? { source: { kind: 'playlist', playlist: { id: context.pendingPlaylistId } }, player: null }
      : null,
  }),
}));
vi.mock('./autoplay-arm', () => ({ primePlayerAutoplay: vi.fn() }));
vi.mock('@/lib/use-client-id', () => ({ useClientId: () => 'client-1' }));

function respond(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => body })),
  );
}
function success() {
  respond({
    ok: true,
    data: {
      supersededSessionId: null,
      session: {
        id: sessionId,
        status: 'active',
        title: 'Focus',
        generationStatus: 'ok',
        generationStatusScope: null,
        sessionMode: 'repeat',
        coverImageId: null,
        statusMessageSafe: null,
        createdAt: '2026-09-13T00:00:00.000Z',
        updatedAt: '2026-09-13T00:00:00.000Z',
      },
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  context.playlistId = 'playlist-a';
  context.released = false;
  context.pendingPlaylistId = null;
  context.playback.session = { id: sessionId };
  context.playback.player.currentTrack = { trackId: 'current' };
  context.playback.player.status = 'playing';
  context.playback.player.queueItems = [];
  context.playback.player.playableQueueItemIds = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('direct Session track playback', () => {
  it('waits for an old Track outside the active Queue window, then jumps to that exact Track', async () => {
    success();
    const { result, rerender } = renderHook(() => usePlaySessionTrack(vi.fn()));
    await act(async () => {
      await result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    expect(context.engage).not.toHaveBeenCalled();
    expect(context.playback.player.refreshQueue).toHaveBeenCalled();
    expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
    context.playback.player.queueItems = [{ id: 'old-slot', trackId }];
    context.playback.player.playableQueueItemIds = ['old-slot'];
    context.playback = { ...context.playback, player: { ...context.playback.player } };
    rerender();
    expect(context.playback.player.playQueueItem).toHaveBeenCalledWith('old-slot');
    expect(result.current.busyTrackId).toBeNull();
  });

  it('validates even a cached playable Track before jumping and leaves playback alone on rejection', async () => {
    respond({
      ok: false,
      error: { code: 'not_found', message: 'Track unavailable', retryable: false },
    });
    context.playback.player.queueItems = [{ id: 'stale-slot', trackId }];
    context.playback.player.playableQueueItemIds = ['stale-slot'];
    const error = vi.fn();
    const { result } = renderHook(() => usePlaySessionTrack(error));
    await act(async () => {
      await result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    expect(error).toHaveBeenCalled();
    expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
    expect(context.engage).not.toHaveBeenCalled();
  });

  it('abandons a pending jump when another Session becomes the playback source', async () => {
    success();
    const { result, rerender } = renderHook(() => usePlaySessionTrack(vi.fn()));
    await act(async () => {
      await result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    context.playback = { ...context.playback, session: { id: 'another-session' } };
    rerender();
    expect(result.current.busyTrackId).toBeNull();
    context.playback = {
      ...context.playback,
      session: { id: sessionId },
      player: {
        ...context.playback.player,
        queueItems: [{ id: 'old-slot', trackId }],
        playableQueueItemIds: ['old-slot'],
      },
    };
    rerender();
    expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
  });

  it('times out an unavailable Queue selection and permits a retry without a late jump', async () => {
    vi.useFakeTimers();
    success();
    const error = vi.fn();
    const { result, rerender } = renderHook(() => usePlaySessionTrack(error));
    await act(async () => {
      await result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(error).toHaveBeenCalledWith('Couldn’t load that Track. Please retry.');
    expect(result.current.busyTrackId).toBeNull();
    context.playback = {
      ...context.playback,
      player: {
        ...context.playback.player,
        queueItems: [{ id: 'old-slot', trackId }],
        playableQueueItemIds: ['old-slot'],
      },
    };
    rerender();
    expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    expect(context.playback.player.playQueueItem).toHaveBeenCalledWith('old-slot');
  });

  it('abandons a waiting Queue jump as soon as a Playlist handoff is requested', async () => {
    success();
    const { result, rerender } = renderHook(() => usePlaySessionTrack(vi.fn()));
    await act(async () => {
      await result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    context.pendingPlaylistId = 'playlist-b';
    rerender();
    expect(result.current.busyTrackId).toBeNull();
    context.playback = {
      ...context.playback,
      player: {
        ...context.playback.player,
        queueItems: [{ id: 'old-slot', trackId }],
        playableQueueItemIds: ['old-slot'],
      },
    };
    rerender();
    expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
  });

  it('still jumps when another source was already arming before the tap', async () => {
    context.pendingPlaylistId = 'playlist-b';
    success();
    const { result, rerender } = renderHook(() => usePlaySessionTrack(vi.fn()));
    await act(async () => {
      await result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    context.playback = {
      ...context.playback,
      player: {
        ...context.playback.player,
        queueItems: [{ id: 'old-slot', trackId }],
        playableQueueItemIds: ['old-slot'],
      },
    };
    rerender();
    expect(context.playback.player.playQueueItem).toHaveBeenCalledWith('old-slot');
  });

  it('does not replace a newer playback source when selection responds late', async () => {
    success();
    const response = await fetch('/selection-response');
    let complete!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const { result, rerender } = renderHook(() => usePlaySessionTrack(vi.fn()));
    let selection!: Promise<boolean>;
    act(() => {
      selection = result.current.playViaSession({ id: trackId, originSessionId: sessionId });
    });
    context.playback = { ...context.playback, session: { id: 'new-session' } };
    rerender();
    await act(async () => {
      complete(response);
      await selection;
    });
    expect(context.engage).not.toHaveBeenCalled();
    expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
    expect(result.current.busyTrackId).toBeNull();
  });

  it.each(['playing', 'paused'])(
    'toggles the audible Playlist Track when transport is %s',
    async (status) => {
      success();
      context.playback.session = null;
      context.playback.player.currentTrack = { trackId };
      context.playback.player.status = status;
      const { result } = renderHook(() => usePlaySessionTrack(vi.fn()));
      expect(result.current.transportRowPreview).toEqual({ trackId, state: status });
      await act(async () => {
        expect(
          await result.current.playViaSession({ id: trackId, originSessionId: sessionId }),
        ).toBe(true);
      });
      expect(context.playback.player.toggle).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect(context.engage).not.toHaveBeenCalled();
      expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
    },
  );

  it.each(['another Playlist', 'released playback', 'pending Playlist'])(
    'ignores a late selection response after switching from a Playlist to %s',
    async (destination) => {
      success();
      context.playback.session = null;
      const response = await fetch('/selection-response');
      let complete!: (response: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              complete = resolve;
            }),
        ),
      );
      const { result, rerender } = renderHook(() => usePlaySessionTrack(vi.fn()));
      let selection!: Promise<boolean>;
      act(() => {
        selection = result.current.playViaSession({ id: trackId, originSessionId: sessionId });
      });
      // The other-music ask resolves first; the selection request is then out.
      await act(async () => undefined);
      if (destination === 'another Playlist') context.playlistId = 'playlist-b';
      if (destination === 'released playback') context.released = true;
      if (destination === 'pending Playlist') context.pendingPlaylistId = 'playlist-b';
      rerender();
      await act(async () => {
        complete(response);
        await selection;
      });
      expect(context.engage).not.toHaveBeenCalled();
      expect(context.playback.player.playQueueItem).not.toHaveBeenCalled();
      expect(result.current.busyTrackId).toBeNull();
    },
  );
});
