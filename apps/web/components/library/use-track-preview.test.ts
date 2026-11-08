// @vitest-environment jsdom

import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTrackPreviewAnnouncement } from '@/components/player/preview-announcer';
import { useTrackPreview, type PreviewableTrack } from './use-track-preview';

function track(overrides: Partial<PreviewableTrack> = {}): PreviewableTrack {
  return {
    id: 'track-1',
    audioUrl: '/api/audio/track-1',
    title: 'Rain on Tin',
    generatedArtistName: 'Liedmotif',
    coverImageId: null,
    ...overrides,
  };
}

/** A stand-in for the page's <audio> element (jsdom implements no playback). */
function fakeAudio() {
  return {
    src: '',
    paused: true,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
  } as unknown as HTMLAudioElement;
}

function mountPreview() {
  const hook = renderHook(() => ({
    preview: useTrackPreview(vi.fn()),
    announced: useTrackPreviewAnnouncement(),
  }));
  hook.result.current.preview.audioRef.current = fakeAudio();
  return hook;
}

afterEach(() => {
  cleanup();
});

describe('useTrackPreview — mini-player mirror', () => {
  it('announces the playing track with its display fields', () => {
    const { result } = mountPreview();
    act(() => result.current.preview.playTrack(track()));
    act(() => result.current.preview.audioEvents.onPlay());

    expect(result.current.announced).toMatchObject({
      trackId: 'track-1',
      title: 'Rain on Tin',
      artist: 'Liedmotif',
      playing: true,
    });
  });

  it('keeps a paused preview announced and clears a finished one', () => {
    const { result } = mountPreview();
    act(() => result.current.preview.playTrack(track()));
    act(() => result.current.preview.audioEvents.onPlay());
    act(() => result.current.preview.audioEvents.onPause());
    expect(result.current.announced?.playing).toBe(false);

    act(() => result.current.preview.audioEvents.onEnded());
    expect(result.current.announced).toBeNull();
  });

  it('clears the announcement on error and on unmount', () => {
    const first = mountPreview();
    act(() => first.result.current.preview.playTrack(track()));
    act(() => first.result.current.preview.audioEvents.onPlay());
    act(() => first.result.current.preview.audioEvents.onError());
    expect(first.result.current.announced).toBeNull();

    const second = mountPreview();
    act(() => second.result.current.preview.playTrack(track({ id: 'track-2' })));
    act(() => second.result.current.preview.audioEvents.onPlay());
    expect(second.result.current.announced?.trackId).toBe('track-2');
    act(() => second.unmount());

    const observer = renderHook(() => useTrackPreviewAnnouncement());
    expect(observer.result.current).toBeNull();
  });

  it('the announced toggle pauses and resumes the preview audio', () => {
    const { result } = mountPreview();
    const audio = result.current.preview.audioRef.current!;
    act(() => result.current.preview.playTrack(track()));
    act(() => result.current.preview.audioEvents.onPlay());

    Object.defineProperty(audio, 'paused', { value: false, configurable: true });
    act(() => result.current.announced?.toggle());
    expect(audio.pause).toHaveBeenCalled();

    Object.defineProperty(audio, 'paused', { value: true, configurable: true });
    act(() => result.current.announced?.toggle());
    expect(audio.play).toHaveBeenCalledTimes(2);
  });
});
