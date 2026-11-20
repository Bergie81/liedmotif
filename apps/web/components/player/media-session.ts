// Media Session (lock-screen) integration, split from the controller hook so
// the hook stays focused on playback state. Pure DOM calls — no React.

import type { MediaPositionState } from '@liedmotif/shared';
import type { PlayableTrack } from './playable-track';

/**
 * Publish the playback state explicitly: during
 * buffer playback the audible audio is Web Audio, so the UA cannot infer the
 * state from the muted carrier element — it must be told.
 */
export function setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = state;
}

/**
 * Publish (or clear, with null) the lock-screen position. The caller derives
 * the sample from the AudioContext clock during buffer playback — never from
 * the carrier element. Chrome throws on out-of-range values; the shared
 * mapping clamps, and a throwing UA must never break playback.
 */
export function publishMediaSessionPosition(state: MediaPositionState | null): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  if (typeof ms.setPositionState !== 'function') return;
  try {
    if (state == null) ms.setPositionState();
    else ms.setPositionState(state);
  } catch {
    // Position metadata is cosmetic; playback must never depend on it.
  }
}

/**
 * Publish lock-screen metadata for the audible track. The Session Cover
 * outranks per-track artwork (Session-level album art); the track cover is
 * the fallback for tracks that outlived their session. `artwork` says where a
 * cover's image is read (the server, or the device's offline store).
 */
export function setMediaSessionMetadata(
  track: PlayableTrack,
  session: { title: string | null; coverImageId: string | null },
  artwork: (coverImageId: string | null) => MediaImage[],
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title ?? session.title ?? 'Liedmotif Session',
    // The line shown under the title on lock screens: the session Name (the
    // generated artist name is cosmetic and rarely set), never a bare app name.
    artist: session.title ?? track.artist ?? 'Liedmotif',
    album: session.title ?? 'Liedmotif',
    artwork: artwork(session.coverImageId ?? track.coverImageId),
  });
}

/**
 * Bind the lock-screen transport controls. Returns the unbind cleanup.
 * Unsupported actions are ignored per browser.
 */
export function bindMediaSessionActions(handlers: {
  play: () => void;
  pause: () => void;
  nexttrack: () => void;
  previoustrack: () => void;
  /** Lock-screen scrub. Receives the
   * UA-supplied `seekTime` with only its SHAPE guarded — numeric values pass
   * through untouched, non-finite included: `resolveSeekTarget` in the
   * controller's seek funnel is the single validation owner. */
  seekto?: (seconds: number) => void;
}): () => void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return () => undefined;
  const ms = navigator.mediaSession;
  const { seekto, ...transport } = handlers;
  const bindings = Object.entries(transport) as Array<
    [MediaSessionAction, MediaSessionActionHandler]
  >;
  if (seekto) {
    // `seekto` is the one details-shaped action (the transport handlers stay
    // zero-arg): adapt the `MediaSessionActionDetails` callback here.
    bindings.push([
      'seekto',
      (details) => {
        if (typeof details?.seekTime === 'number') seekto(details.seekTime);
      },
    ]);
  }
  for (const [action, handler] of bindings) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // unsupported action on this browser
    }
  }
  return () => {
    for (const [action] of bindings) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // ignore
      }
    }
    ms.metadata = null;
  };
}
