// The PlayerProvider's deterministic state rules, kept out of the React
// component so the engage/pairing seam is unit-testable: which entry an
// engage produces, and when an engaged source and a hosted controller
// combine into live playback.
//
// The player plays one Playback source — a Session or a Playlist.
// The handoff machinery below is generic over sources: entries are keyed by
// source id, so Session→Playlist and Playlist→Session hand off audibly with
// the same crossfade as Session→Session. Engaging a Playlist never touches
// the Active Session's lifecycle — its host simply unmounts (Active-but-idle;
// the playback gate stops its top-ups because reports stop).

import type {
  ActivitySessionStatus,
  PlaylistMemberItem,
  PlaylistSummaryItem,
  SessionSummary,
} from '@liedmotif/shared';
import type { PlayableTrack } from './playable-track';
import type { PlayerStatus, PlaybackControllerApi } from './playback-controller-api';

/** The engaged Playback source: a Session or a Playlist, or an
 *  Available-offline collection the Offline Library plays from this device. */
export type EngagedSource =
  | { kind: 'session'; session: SessionSummary }
  | {
      kind: 'playlist';
      playlist: PlaylistSummaryItem;
      /** The full ordered membership at engage time (a Playlist has no server
       *  queue — its persisted order IS the play order). */
      items: PlaylistMemberItem[];
      /** Start at this member instead of the top (row tap). */
      startTrackId: string | null;
      /** Another owner's In-Lounge playlist: the surfaces render
       *  the visitor scope — listening only, no curation, no owner stamps. */
      foreign: boolean;
    }
  | {
      kind: 'offline';
      /** The offline mark's key (`playlist:<id>`): the source id. */
      key: string;
      name: string;
      /** In play order, each playing its device copy. */
      tracks: PlayableTrack[];
      startTrackId: string | null;
      /** Whether a Track's copy has expired on this device by now. */
      expired: (trackId: string) => boolean;
    };

/** The id the provider keys hosts/handoffs on. */
export function engagedSourceId(source: EngagedSource): string {
  switch (source.kind) {
    case 'session':
      return source.session.id;
    case 'playlist':
      return source.playlist.id;
    case 'offline':
      return source.key;
  }
}

/** What the source is called: the Session or Playlist name. */
export function engagedSourceName(source: EngagedSource): string | null {
  switch (source.kind) {
    case 'session':
      return source.session.title;
    case 'playlist':
      return source.playlist.name;
    case 'offline':
      return source.name;
  }
}

/** A source the provider has been asked to play (the host's mount input). */
export interface PlaybackEntry {
  source: EngagedSource;
  /** Arm deferred auto-start (read once, at controller mount). */
  autoplay: boolean;
}

/** What the mounted controller publishes for consumers. */
export interface HostedController {
  sourceId: string;
  player: PlaybackControllerApi;
  /** The controller's mount instant — anchors the cold-start staged copy. */
  coldStartBeganAt: string;
}

export interface LivePlayback {
  source: EngagedSource;
  /** The engaged Session, null while a Playlist plays (the Session shell
   *  renders only when this is set). */
  session: SessionSummary | null;
  player: PlaybackControllerApi;
  coldStartBeganAt: string;
}

/** The summary comes from the entry (fresh synchronously — Change Vibe must
 * not wait a tick); the api from the hosted controller. They pair only while
 * they describe the same source — mid-switch there is no live playback. */
export function pairLivePlayback(
  entry: PlaybackEntry | null,
  hosted: HostedController | null,
): LivePlayback | null {
  return entry && hosted && hosted.sourceId === engagedSourceId(entry.source)
    ? {
        source: entry.source,
        session: entry.source.kind === 'session' ? entry.source.session : null,
        player: hosted.player,
        coldStartBeganAt: hosted.coldStartBeganAt,
      }
    : null;
}

/** The provider's full playback state during a source handoff: `entry` is the
 * source consumers see, `pending` a source engaged while the entry was
 * audible (mounted muted, arming toward its first audible track), `draining`
 * the outgoing source an in-progress crossfade is fading out. */
export interface ProviderPlaybackState {
  entry: PlaybackEntry | null;
  pending: PlaybackEntry | null;
  draining: PlaybackEntry | null;
}

export const idlePlaybackState: ProviderPlaybackState = {
  entry: null,
  pending: null,
  draining: null,
};

/** How long the cross-source crossfade runs (equal-power, both master outputs). */
export const HANDOFF_FADE_MS = 5000;

/** The engage transition over the handoff state: same ids refresh in place;
 * a different source arms a muted pending handoff while the entry is audible
 * (continuity — it must auto-start for the crossfade to ever fire), and swaps
 * directly otherwise. */
export function engagePlayback(
  state: ProviderPlaybackState,
  source: EngagedSource,
  autoplay: boolean,
  entryAudible: boolean,
): ProviderPlaybackState {
  const sourceId = engagedSourceId(source);
  // Re-engaging the source a crossfade is currently fading OUT drops the
  // drain — the ids may not collide across the keyed hosts.
  const draining =
    state.draining && engagedSourceId(state.draining.source) === sourceId ? null : state.draining;
  if (!state.entry) return { entry: { source, autoplay }, pending: null, draining };
  if (engagedSourceId(state.entry.source) === sourceId) {
    return { ...state, entry: { ...state.entry, source }, draining };
  }
  if (state.pending && engagedSourceId(state.pending.source) === sourceId) {
    return { ...state, pending: { ...state.pending, source }, draining };
  }
  if (entryAudible) {
    return { ...state, pending: { source, autoplay: true }, draining };
  }
  return { entry: { source, autoplay }, pending: null, draining };
}

/** The pending source became audible over an audible entry: promote it and
 * fade the old source out. No-op without a pending source, so a repeated
 * dispatch can never drop the entry. */
export function beginHandoffDrain(state: ProviderPlaybackState): ProviderPlaybackState {
  if (!state.pending) return state;
  return { entry: state.pending, pending: null, draining: state.entry };
}

/** The pending source became audible while the entry was not: swap without
 * a fade (the old host unmounts silently). No-op without a pending source. */
export function promotePendingPlayback(state: ProviderPlaybackState): ProviderPlaybackState {
  if (!state.pending) return state;
  return { entry: state.pending, pending: null, draining: null };
}

/** The crossfade finished: release the drained host. */
export function endHandoffDrain(state: ProviderPlaybackState): ProviderPlaybackState {
  return { ...state, draining: null };
}

/** The pending source will never play (a session stopped before its first track). */
export function abandonPendingPlayback(state: ProviderPlaybackState): ProviderPlaybackState {
  return { ...state, pending: null };
}

/** Stop the visible source. An arming handoff survives as the new entry —
 * the user stopped the OLD music, not the source they just asked for. */
export function releasePlayback(state: ProviderPlaybackState): ProviderPlaybackState {
  return { entry: state.pending, pending: null, draining: null };
}

export type PendingHandoffAction = 'begin-drain' | 'promote' | 'promote-paused' | 'abandon';

/** What the provider should do with an arming pending source right now.
 * Null = keep waiting (still arming, or a recoverable generation degrade —
 * the entry keeps playing meanwhile). An entry the user explicitly PAUSED
 * promotes paused: a pause is "not now" for all music, so the new source
 * must not blare in on its own once ready. (A Playlist never reports
 * `stopped` — abandon is a Session-only exit.) */
export function pendingHandoffAction(input: {
  pendingStatus: PlayerStatus | null;
  pendingSessionStatus: ActivitySessionStatus;
  entryStatus: PlayerStatus | null;
}): PendingHandoffAction | null {
  if (input.pendingStatus === 'playing') {
    if (input.entryStatus === 'playing') return 'begin-drain';
    return input.entryStatus === 'paused' ? 'promote-paused' : 'promote';
  }
  if (input.pendingSessionStatus === 'stopped') return 'abandon';
  return null;
}

/** The cross-source handoff's fade length under the owner's blend setting:
 * blends off means sources hand off with an immediate hard cut. */
export function handoffFadeDurationMs(blendEnabled: boolean): number {
  return blendEnabled ? HANDOFF_FADE_MS : 0;
}

/** Equal-power gains for the cross-source crossfade at `elapsedMs`. */
export function handoffFadeGains(
  elapsedMs: number,
  durationMs: number,
): { incoming: number; outgoing: number; done: boolean } {
  const progress = durationMs <= 0 ? 1 : Math.min(1, Math.max(0, elapsedMs / durationMs));
  // A completed fade lands on exact endpoints (cos(π/2) leaves float residue).
  if (progress >= 1) return { incoming: 1, outgoing: 0, done: true };
  return {
    incoming: Math.sin((progress * Math.PI) / 2),
    outgoing: Math.cos((progress * Math.PI) / 2),
    done: false,
  };
}

/** The hosts the Sleep Timer silences: what is audible. A pending source arms
 *  muted and only hands off once it plays, so pausing it would strand the
 *  Start the listener asked for; if it lands after the timer has paused the
 *  entry, `promote-paused` keeps it quiet. */
export function sleepTimerTargets(state: ProviderPlaybackState): string[] {
  return [state.entry, state.draining]
    .filter((slot): slot is PlaybackEntry => slot !== null)
    .map((slot) => engagedSourceId(slot.source));
}
