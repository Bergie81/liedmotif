// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTrackPreviewAnnouncement } from '@/components/player/preview-announcer';

const transportPlay = vi.hoisted(() => ({
  state: { trackId: null as string | null, state: 'paused' as 'playing' | 'paused' },
}));
vi.mock('@/components/player/use-play-session-track', () => ({
  usePlaySessionTrack: () => ({
    playViaSession: async (track: { id: string }) => {
      transportPlay.state = { trackId: track.id, state: 'playing' };
    },
    busyTrackId: null,
    transportRowPreview: transportPlay.state,
  }),
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
      playback: useTrackRowPlayback(vi.fn()),
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
