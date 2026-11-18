// The player's track projection + blend-edge telemetry contract.
// Shared by the controller hook, the edge-transition driver, and the e2e
// specs' type declarations — kept out of the hook so those modules need not
// import React code.

import type {
  BlendAnalysis,
  EdgeDegradeReason,
  EdgeLoudness,
  EdgeTier,
  QueueItem,
  VocalMode,
} from '@liedmotif/shared';

/** A queue track resolved to something playable through pinned app-routed audio. */
export interface PlayableTrack {
  queueItemId: string;
  trackId: string;
  /** The server queue-slot lifecycle state. */
  queueState: QueueItem['state'];
  /** Authoritative provenance for switch-now material omitted by forward navigation. */
  vibeSwitchSetAside: boolean;
  title: string | null;
  artist: string | null;
  /** Origin Session Name for Playlist presentation; null on Session Queue projections. */
  originSessionTitle: string | null;
  durationSeconds: number | null;
  coverImageId: string | null;
  /** Whether the track is Saved — drives the Save control state. */
  savedAt: string | null;
  /** Favorite is a retention/star flag and implies Save. */
  favoritedAt: string | null;
  /** The Add to Playlist control's lit state — `savedAt` cannot stand in for
   *  it, because starring sets that too. */
  inCuratedPlaylist: boolean;
  /** The track's own genre tags (the player's status-line genre readout). */
  genreTags: string[];
  /** The TRACK's vocal mode — the status line's vocals readout. */
  vocalMode: VocalMode;
  /** True once the provider-written lyric text is captured (vocal tracks only);
   *  with `vocalMode` it gates every lyrics affordance (sleeve tab, sheet row). */
  hasLyrics: boolean;
  /** True when the stored, tagged local final can be fetched from the download
   *  route — stricter than a playable stream pin; gates the Download Track row. */
  downloadable: boolean;
  /** Pinned per-source audio paths — the deck source ladder. */
  assets: { final: string | null; stream: string | null };
  /** Generation-time blend identity (null = legacy → plain edge, always). */
  styleRevision: number | null;
  targetBpm: number | null;
  targetKey: string | null;
  /** Measured analysis (null while pending / suppressed as stale). */
  blendAnalysis: BlendAnalysis | null;
  /** The Session Queue slot's position (Resume finds the next remaining Track
   *  by it); absent on Playlist and Offline Library projections. */
  queuePosition?: number;
}

/** A queue slot resolved for playback targeting: the projection index plus its
 * track. The transition driver's next-target, the repeat-one pin, and the
 * controller's navigation all speak this shape. */
export interface QueueTarget {
  idx: number;
  track: PlayableTrack;
  /** True when forward navigation reached this target by wrapping past the end
   *  of the projection — the Queue loop restarting, not an ordinary advance.
   *  Rides the target into its `started` report (`queueWrapped`), where the
   *  server widens the switch-now set-aside clear to the whole session. */
  wrapped?: boolean;
}

/** A playing track as the options sheets act on it (untitled reads as the
 *  player's display fallback). */
export function optionsTrackOf(
  track: Pick<PlayableTrack, 'trackId' | 'title' | 'downloadable'> | null,
): { trackId: string; title: string; downloadable: boolean } | null {
  if (!track) return null;
  return {
    trackId: track.trackId,
    title: track.title ?? 'Untitled Track',
    downloadable: track.downloadable,
  };
}

/** Loudness measurements of a track, as the edge normalization consumes them. */
export function loudnessOf(track: PlayableTrack | null): EdgeLoudness {
  return {
    lufs: track?.blendAnalysis?.integratedLufs ?? null,
    truePeakDb: track?.blendAnalysis?.truePeakDb ?? null,
  };
}

/** Detail of the `liedmotif:blend-edge` telemetry event (real-time measurement).
 * The context-clock fields let the acceptance job reconstruct AUDIBLE beat
 * positions for media with known ground-truth beats: incoming beats live at
 * `actualStartContextTime + beat/incomingRate` on the context clock. */
export interface BlendEdgeEventDetail {
  tier: EdgeTier;
  reasons: EdgeDegradeReason[];
  /** Whether this edge actually COMMITTED the handoff. Failed attempts
   * (`prepare-failed`/`start-missed`) emit `false`: they are counted by the
   * acceptance measurement but the track they targeted arrives later by a
   * sequential hard cut — only committed edges may become the player's
   * displayed active tier. */
  committed: boolean;
  /** The committed track (null only for failures before a target existed). */
  trackId: string | null;
  /** Signed incoming-start phase error vs the plan; null for unplanned (plain) edges. */
  phaseErrorMs: number | null;
  /** Where the incoming element's media time 0 actually landed on the context clock. */
  actualStartContextTime: number | null;
  /** The planned fade start on the context clock (aligned edges; RENDER time). */
  fadeStartContextTime: number | null;
  /** When the fade becomes AUDIBLE at the speakers (render + latency). */
  presentationFadeStartContextTime: number | null;
  /** The incoming element's applied playback rate. */
  incomingRate: number | null;
  fadeSeconds: number;
}

export function emitBlendEdge(detail: BlendEdgeEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<BlendEdgeEventDetail>('liedmotif:blend-edge', { detail }));
}
