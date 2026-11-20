'use client';

import { useEffect, useRef, useState } from 'react';
import type { LibraryTrackItem } from '@liedmotif/shared';
import {
  announceTrackPreview,
  clearTrackPreview,
  createPreviewOwner,
} from '@/components/player/preview-announcer';
import { useListeningMeter } from '@/components/player/use-listening-meter';
import type { PreviewState } from './track-row';

/** The fields preview playback and its mini-player mirror need — satisfied by
 *  library items and search results alike. */
export type PreviewableTrack = Pick<
  LibraryTrackItem,
  'id' | 'audioUrl' | 'title' | 'generatedArtistName' | 'coverImageId'
>;

export function useTrackPreview(onError: (message: string) => void) {
  const [preview, setPreview] = useState<{ trackId: string | null; state: PreviewState }>({
    trackId: null,
    state: 'idle',
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<PreviewableTrack | null>(null);
  const ownerRef = useRef(createPreviewOwner());
  // Personal-analytics metering. A preview has no Session and no
  // Queue item, so its reports carry neither and can wake no Buffer.
  const meter = useListeningMeter(preview.state === 'playing', () => {
    const audio = audioRef.current;
    return {
      position: audio?.currentTime ?? null,
      audible: !!audio && !audio.muted && audio.volume > 0,
    };
  });

  useEffect(() => {
    const owner = ownerRef.current;
    return () => {
      // Previews are page-local: leaving the surface stops the audio and takes
      // the mini-player mirror down with it.
      audioRef.current?.pause();
      clearTrackPreview(owner);
    };
  }, []);

  /** Mirror the preview into the mini player while it is audible or paused. */
  function announce(track: PreviewableTrack, playing: boolean): void {
    announceTrackPreview(ownerRef.current, {
      trackId: track.id,
      title: track.title,
      artist: track.generatedArtistName,
      coverImageId: track.coverImageId,
      playing,
      toggle: () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) void audio.play().catch((error) => playRefused(error, track.id));
        else audio.pause();
      },
    });
  }

  function failPreview(trackId: string) {
    if (trackRef.current?.id !== trackId) return;
    meter().close(trackId, 'failed');
    setPreview({ trackId, state: 'idle' });
    clearTrackPreview(ownerRef.current);
    onError('This track could not be played. Try again later.');
  }

  // A pause while `play()` is pending rejects it with AbortError: that is the
  // listener's own pause, not a failure. A real load failure fires `error`.
  function playRefused(error: unknown, trackId: string) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    failPreview(trackId);
  }

  function playTrack(track: PreviewableTrack) {
    const audio = audioRef.current;
    if (!audio || !track.audioUrl) return;

    const nextSource = new URL(track.audioUrl, window.location.href).href;
    if (audio.src !== nextSource) {
      audio.pause();
      audio.src = track.audioUrl;
    }
    trackRef.current = track;
    setPreview({ trackId: track.id, state: 'idle' });
    void audio.play().catch((error) => playRefused(error, track.id));
  }

  function togglePreview(track: PreviewableTrack) {
    const audio = audioRef.current;
    if (!audio || !track.audioUrl) return;
    if (trackRef.current?.id === track.id && !audio.paused) {
      audio.pause();
      return;
    }
    playTrack(track);
  }

  /** Silence the preview for good: once another player owns the audio, a
   *  paused preview must not keep speaking for the rows or the mini player. */
  function stop() {
    const track = trackRef.current;
    // Cleared first, so the `pause` event this fires is not read as a paused preview.
    trackRef.current = null;
    audioRef.current?.pause();
    if (!track) return;
    meter().close(track.id, 'navigated');
    setPreview({ trackId: null, state: 'idle' });
    clearTrackPreview(ownerRef.current);
  }

  function updateState(state: PreviewState) {
    const track = trackRef.current;
    if (!track) return;
    // `play` cannot tell a start from a resume; the meter continues the open
    // occurrence of the same Track and opens one for anything else.
    if (state === 'playing')
      meter().resume({ trackId: track.id, sessionId: null, surface: 'preview' });
    else if (state === 'ended') meter().close(track.id, 'ended');
    setPreview({ trackId: track.id, state });
    // The mirror tracks audibility: playing/paused stay up (the bar is how a
    // paused preview resumes), a finished or failed preview takes it down.
    if (state === 'playing' || state === 'paused') announce(track, state === 'playing');
    else clearTrackPreview(ownerRef.current);
  }

  return {
    audioRef,
    preview,
    playTrack,
    togglePreview,
    stop,
    audioEvents: {
      onPlay: () => updateState('playing'),
      onPause: () => updateState('paused'),
      onEnded: () => updateState('ended'),
      onError: () => {
        const trackId = trackRef.current?.id;
        if (trackId) failPreview(trackId);
      },
    },
  };
}
