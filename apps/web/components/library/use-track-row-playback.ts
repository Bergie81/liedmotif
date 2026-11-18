'use client';

// What a tappable track row needs to play, wherever the row lives (Library,
// search): the transport for tracks that still have an origin Session, the
// page-local preview for the ones whose Session was deleted, and one play
// state the row can read without knowing which of the two is making sound.

import type { TrackPlayTarget } from '@/components/player/play-track-intent';
import { usePlaySessionTrack } from '@/components/player/use-play-session-track';
import { toast } from '@/lib/toast';
import type { PreviewState } from './track-row';
import { useTrackPreview, type PreviewableTrack } from './use-track-preview';

/** A row this hook can play: reachable through the transport, previewable if not. */
export type PlayableTrackRow = TrackPlayTarget & PreviewableTrack;

/** How a row renders right now, from whichever source owns the audio. */
export interface RowPreview {
  trackId: string | null;
  state: PreviewState;
}

/**
 * The preview wins only while it is audible or paused — otherwise the row
 * reports the transport, so an idle or finished preview never blanks the state
 * of a track the transport is still playing.
 */
export function resolveRowPreview(preview: RowPreview, transport: RowPreview): RowPreview {
  return preview.state === 'playing' || preview.state === 'paused' ? preview : transport;
}

/** A play that fails is an error toast under `failureKey`, which the next
 *  row's play clears. */
export function useTrackRowPlayback(failureKey: string) {
  const onError = (message: string) => toast.error(message, { key: failureKey });
  const preview = useTrackPreview(onError);
  const sessionPlay = usePlaySessionTrack(onError);

  /**
   * A Track plays through its origin Session (the real transport); only a
   * track whose Session was deleted falls back to the page-local preview.
   * Handing the row to the transport stops a preview left playing or paused,
   * since the two share no audio element.
   */
  function playRow(track: PlayableTrackRow) {
    toast.dismiss(failureKey);
    if (track.originSessionId) {
      preview.stop();
      void sessionPlay.playViaSession(track);
    } else {
      preview.togglePreview(track);
    }
  }

  return {
    playRow,
    rowPreview: resolveRowPreview(preview.preview, sessionPlay.transportRowPreview),
    /** Set while a row is waiting on the server to hand it the transport. */
    busyTrackId: sessionPlay.busyTrackId,
    audioRef: preview.audioRef,
    audioEvents: preview.audioEvents,
  };
}
