// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTrackPreviewAnnouncement } from '@/components/player/preview-announcer';

const transportPlay = vi.hoisted(() => ({
  state: { trackId: null as string | null, state: 'paused' as 'playing' | 'paused' },
  supersede: (() => {}) as () => void,
}));
vi.mock('@/components/player/use-play-session-track', () => ({
  usePlaySessionTrack: () => ({
    playViaSession: async (track: { id: string }) => {
      transportPlay.state = { trackId: track.id, state: 'playing' };
    },
    busyTrackId: null,
    transportRowPreview: transportPlay.state,
    supersede: () => transportPlay.supersede(),
  }),
}));

// The player's transport, as `usePlayerContext` hands it out: whatever is
// engaged (a Session or a Playlist), paused through the same controller.
const transportPlayer = vi.hoisted(() => ({
  status: 'paused' as 'playing' | 'paused' | 'waiting',
  playIntentPending: false,
  pause: () => {},
}));
vi.mock('@/components/player/player-provider', () => ({
  usePlayerContext: () => ({ playback: { player: transportPlayer } }),
}));

const { resolveRowPreview, useTrackRowPlayback } = await import('./use-track-row-playback');
type RowPreview = import('./use-track-row-playback').RowPreview;

const transport: RowPreview = { trackId: 'transport-track', state: 'playing' };

describe('resolveRowPreview', () => {
  it('lets an audible or paused preview speak for the row', () => {
    for (const state of ['playing', 'paused'] as const) {
      const preview: RowPreview = { trackId: 'preview-track', state };
      expect(resolveRowPreview(preview, transport)).toEqual(preview);
    }
  });

  it('falls back to the transport once the preview is idle or finished', () => {
    for (const state of ['idle', 'ended'] as const) {
      const preview: RowPreview = { trackId: 'preview-track', state };
      expect(resolveRowPreview(preview, transport)).toEqual(transport);
    }
  });

  it('reports the transport idle-and-empty when neither is playing', () => {
    const silent: RowPreview = { trackId: null, state: 'idle' };
    expect(resolveRowPreview({ trackId: null, state: 'idle' }, silent)).toEqual(silent);
  });
});

describe('useTrackRowPlayback — handing a row to the transport', () => {
  afterEach(() => {
    cleanup();
    transportPlay.state = { trackId: null, state: 'paused' };
  });

  function row(id: string, originSessionId: string | null) {
    return {
      id,
      originSessionId,
      audioUrl: `/api/audio/${id}`,
      title: 'Track',
      generatedArtistName: null,
      coverImageId: null,
    };
  }

  it('takes a playing preview down for good, so the rows and the mini player follow the transport', async () => {
    const { result, rerender } = renderHook(() => ({
      playback: useTrackRowPlayback('library-play'),
      announced: useTrackPreviewAnnouncement(),
    }));
    const audio = {
      src: '',
      paused: true,
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
    } as unknown as HTMLAudioElement;
    result.current.playback.audioRef.current = audio;

    act(() => result.current.playback.playRow(row('orphan-1', null)));
    act(() => result.current.playback.audioEvents.onPlay());
    expect(result.current.announced?.trackId).toBe('orphan-1');

    await act(async () =>
      result.current.playback.playRow(row('session-track', '223e4567-e89b-12d3-a456-426614174000')),
    );
    expect(audio.pause).toHaveBeenCalled();
    act(() => result.current.playback.audioEvents.onPause());
    rerender();

    expect(result.current.playback.rowPreview).toEqual({
      trackId: 'session-track',
      state: 'playing',
    });
    expect(result.current.announced).toBeNull();
  });
});

describe('useTrackRowPlayback — a preview and the music playing', () => {
  afterEach(() => {
    cleanup();
    transportPlayer.status = 'paused';
    transportPlayer.playIntentPending = false;
    vi.restoreAllMocks();
  });

  function orphan(id: string) {
    return {
      id,
      originSessionId: null,
      audioUrl: `/api/audio/${id}`,
      title: 'Track',
      generatedArtistName: null,
      coverImageId: null,
    };
  }

  function mount() {
    const pause = vi.spyOn(transportPlayer, 'pause').mockImplementation(() => {
      transportPlayer.status = 'paused';
      transportPlayer.playIntentPending = false;
    });
    const hook = renderHook(() => ({
      playback: useTrackRowPlayback('library-play'),
      announced: useTrackPreviewAnnouncement(),
    }));
    const audio = {
      src: '',
      paused: true,
      play: vi.fn(() => {
        (audio as { paused: boolean }).paused = false;
        return Promise.resolve();
      }),
      pause: vi.fn(() => {
        (audio as { paused: boolean }).paused = true;
      }),
    } as unknown as HTMLAudioElement;
    hook.result.current.playback.audioRef.current = audio;
    return { ...hook, audio, pause };
  }

  it('starting a preview pauses the transport', () => {
    transportPlayer.status = 'playing';
    const { result, audio, pause } = mount();

    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPlay());

    expect(audio.play).toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(transportPlayer.status).toBe('paused');
    expect(result.current.playback.rowPreview).toEqual({ trackId: 'orphan-1', state: 'playing' });
  });

  it('pausing a preview pauses only the preview and leaves the transport alone', () => {
    transportPlayer.status = 'playing';
    const { result, audio, pause } = mount();
    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPlay());
    pause.mockClear();

    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPause());

    expect(audio.pause).toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('leaves the music paused once the preview ends, fails or is stopped', () => {
    transportPlayer.status = 'playing';
    const { result, pause } = mount();
    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPlay());
    act(() => result.current.playback.audioEvents.onEnded());
    act(() => result.current.playback.playRow(orphan('orphan-2')));
    act(() => result.current.playback.audioEvents.onPlay());
    act(() => result.current.playback.audioEvents.onError());

    expect(pause).toHaveBeenCalledTimes(1);
    expect(transportPlayer.status).toBe('paused');
  });

  it('pauses the transport again when the preview resumes from the mini player', () => {
    transportPlayer.status = 'playing';
    const { result, audio, pause } = mount();
    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPlay());
    act(() => result.current.announced?.toggle());
    act(() => result.current.playback.audioEvents.onPause());
    // The listener resumes the music from the player while the preview is paused.
    transportPlayer.status = 'playing';

    act(() => result.current.announced?.toggle());
    act(() => result.current.playback.audioEvents.onPlay());

    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(transportPlayer.status).toBe('paused');
  });

  it('disarms a transport that is waiting to start, so it cannot start over the preview', () => {
    transportPlayer.status = 'waiting';
    transportPlayer.playIntentPending = true;
    const { result, pause } = mount();

    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPlay());

    expect(pause).toHaveBeenCalledTimes(1);
    expect(transportPlayer.playIntentPending).toBe(false);
  });

  it('cancels a row still waiting to hand its Track to the transport', () => {
    const supersede = vi.spyOn(transportPlay, 'supersede');
    const { result } = mount();

    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPlay());

    expect(supersede).toHaveBeenCalledTimes(1);
  });

  it('changes nothing in the transport when nothing is playing there', () => {
    const { result, pause } = mount();

    act(() => result.current.playback.playRow(orphan('orphan-1')));
    act(() => result.current.playback.audioEvents.onPlay());

    expect(pause).not.toHaveBeenCalled();
  });
});
