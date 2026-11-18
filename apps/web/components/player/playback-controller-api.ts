// The session player's PUBLIC surface: the render-state shape and the API the
// Now Playing card and the e2e declarations type against. Split from
// `use-session-player.ts` so the controller file holds the orchestration and this one the contract.

import type {
  ActivitySessionStatus,
  BufferLoopRegion,
  CommittedSourceKind,
  EdgeTier,
  PendingGeneration,
  PlaybackMode,
  QueueItem,
  SessionGenerationStatus,
  SessionMode,
  SessionVibe,
} from '@liedmotif/shared';
import type { PlayableTrack } from './playable-track';
import type { TrackRetentionFlags } from './track-retention';

export type PlayerStatus = 'loading' | 'ready' | 'playing' | 'paused' | 'waiting' | 'ended';

/**
 * What the controller plays (one transport, two Playback sources).
 * A Session source polls the server-authoritative Queue and reports playback
 * (the top-up gate); a Playlist source carries its full static, ordered
 * membership, sends NO playback reports (an idle Active Session must spend
 * nothing), and leaves every generative affordance inert. An offline Playlist
 * source goes further and reaches the server for nothing.
 */
export type PlayerControllerSource =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'playlist';
      playlistId: string;
      /** The projected members in user order (`queueItemId` = track id — a
       *  playlist has no queue slots and no duplicate members). */
      tracks: PlayableTrack[];
      startTrackId: string | null;
      /** The Tracks play from this device's offline store (the Offline
       *  Library): the controller then makes no server call at all — no
       *  listening reports and no playback-settings read. */
      offline?: boolean;
      /** Whether a Track's offline copy has expired on this device, judged
       *  before every new start; the Track already playing finishes. Absent:
       *  nothing expires. */
      expired?: (trackId: string) => boolean;
    };

/** The truthful playback clock sample: the buffer transport's context-clock
 * view while a decoded buffer carries the deck, the media element's otherwise.
 * Deliberately NOT part of `PlaybackControllerState` — position changes at slider
 * frequency and must never re-render the whole Now Playing card. */
export interface PlaybackSample {
  positionSeconds: number | null;
  durationSeconds: number | null;
  playbackRate: number;
}

/** The Loop a Part tool. It stays open across Track changes; `region` is the
 *  live Section loop, and never outlives the Track it was marked on. */
export type SectionLoopTool =
  | { phase: 'closed' }
  /** Decoding the Track's final. */
  | { phase: 'preparing' }
  /** Nothing to loop yet: no final (still streaming), or it will not decode. */
  | { phase: 'unavailable' }
  /** `durationSeconds` is the decoded buffer's, the length the loop really runs on. */
  | { phase: 'ready'; bars: number[]; durationSeconds: number; region: BufferLoopRegion | null };

export const CLOSED_SECTION_LOOP_TOOL: SectionLoopTool = { phase: 'closed' };

/** Whether a Section loop is repeating right now. */
export function sectionLoopLive(tool: SectionLoopTool): boolean {
  return tool.phase === 'ready' && tool.region != null;
}

/** The Loop a Part tool as a control drives it. */
export interface SectionLoopControl {
  open: boolean;
  available: boolean;
  onToggle: () => void;
}

export function sectionLoopControl(
  player: Pick<
    PlaybackControllerApi,
    'sectionLoopTool' | 'sectionLoopAvailable' | 'toggleSectionLoopTool'
  >,
): SectionLoopControl {
  return {
    open: player.sectionLoopTool.phase !== 'closed',
    available: player.sectionLoopAvailable,
    onToggle: player.toggleSectionLoopTool,
  };
}

export interface PlaybackControllerState {
  /** The Session's New music policy as last polled (another device may change it). */
  sessionMode?: SessionMode;
  targetDurationMinutes?: number | null;
  generatedDurationSeconds?: number;
  unknownDurationTrackCount?: number;
  status: PlayerStatus;
  /** A Play intent is armed but has not produced audible playback yet. */
  playIntentPending: boolean;
  currentTrack: PlayableTrack | null;
  generationStatus: SessionGenerationStatus;
  /** Which bound a Member's cost-limit names (member/pool). */
  generationStatusScope: 'member' | 'pool' | null;
  statusMessageSafe: string | null;
  sessionStatus: ActivitySessionStatus;
  /** Client-side traversal policy for this engaged Session. */
  playbackMode: PlaybackMode;
  /** The live Session Cover (queue poll) — canonical artwork for every track in
   *  the Session; refreshes in place when the async generated cover lands. */
  sessionCoverImageId: string | null;
  queueLength: number;
  /** Playable Tracks the Session's windowed queue read elided ahead of the
   *  window — they count before it in the Track numbering. The loop head, when
   *  it leads the projection, is one of them. 0 for a Playlist, which is read
   *  whole. */
  earlierTracks: number;
  /** Queue item ids in the live playable projection. */
  playableQueueItemIds: string[];
  /** Ordered server-authoritative Queue slots, including non-playable work in progress.
   *  Windowed by the server: recent history plus everything from the current item
   *  forward. */
  queueItems: QueueItem[];
  /** Tracks the server's in-flight provider jobs still owe — the server's part
   *  of the "on the way" count, in Tracks rather than provider calls. */
  generatingTracksAhead: number;
  /** The part of that count ordered at the Session's live style revision; a
   *  vibe change is what makes it readable as "the new vibe is coming". */
  generatingNewVibeTracksAhead: number;
  /** The in-flight generation while the Session has NO playable track yet
   * (stage + submit timestamp from the queue poll). Null once one
   * exists — drives the cold-start staged copy and the synthetic
   * progress bar. */
  pendingGeneration: PendingGeneration | null;
  /** The session's LIVE style revision (queue poll); null until the first
   *  poll lands. With per-item revisions it locates the vibe boundary. */
  styleRevision: number | null;
  /** The current vibe facets — the Change Vibe overlay's preselection source. */
  vibe: SessionVibe | null;
  /** True while a switch-now vibe change is armed server-side. */
  switchPending: boolean;
  /** Tracks one Try again buys when the Session has nothing to play; null when
   *  the server offers no Try again (a request blocked for its content). */
  tryAgainTracks: number | null;
  /** Whether the current track is Favorited — the star's pressed state. */
  currentFavorited: boolean;
  /** The Add to Playlist control's pressed state. Favorites is excluded, so it
   * and `currentFavorited` never move together. */
  currentInCuratedPlaylist: boolean;
  /** Whether the seamless repeat-one pin and generation lease are live. */
  loopActive: boolean;
  /** Committed source kind of the audible deck — the pinned URL that actually
   * loaded; null until a source commits. Drives the source badge. */
  sourceKind: CommittedSourceKind | null;
  /** Tier of the most recent COMMITTED blend handoff — the Now Playing debug
   * chip's on-device tier readout. Failed attempts never set
   * it, and every hard-cut load clears it: the readout only ever describes
   * the edge that actually delivered current playback. */
  activeEdgeTier: EdgeTier | null;
  sectionLoopTool: SectionLoopTool;
}

/** Mount-time seeds for the controller (the queue poll keeps them fresh). */
export interface PlaybackControllerInit {
  generationStatus?: SessionGenerationStatus;
  generationStatusScope?: 'member' | 'pool' | null;
  statusMessageSafe?: string | null;
  /** The Playback source's name (Session Name or Playlist name) for
   * lock-screen/notification metadata (Media Session). */
  sourceTitle?: string | null;
  /** The Session Cover at mount; the queue poll keeps it fresh afterwards. */
  coverImageId?: string | null;
  /** Where lock-screen artwork is read — the provider's `TrackMedia`; the
   *  server's covers when absent. Re-read live every render. */
  artwork?: (coverImageId: string | null) => MediaImage[];
  /** Arm deferred playback at mount: a session started by the
   * user's own click auto-starts when its first track becomes playable —
   * pause while preparing disarms it. Never set for resumed/rediscovered
   * sessions (a reload must not blare unprompted). */
  autoplay?: boolean;
  /** Mount-time output level (0..1). A pending session arming behind an
   * audible one mounts at 0; the handoff crossfade ramps it up. */
  initialOutputVolume?: number;
  /** Whether THIS controller owns the global Media Session (lock-screen
   * metadata, position, action handlers). Exactly one of the provider's
   * hosts — the visible entry — may own it; re-read live every render. */
  mediaSessionEnabled?: boolean;
}

/** The render-state seed for a freshly mounted player. */
export function initialPlaybackControllerState(
  initial?: PlaybackControllerInit,
): PlaybackControllerState {
  return {
    status: 'loading',
    playIntentPending: initial?.autoplay ?? false,
    currentTrack: null,
    generationStatus: initial?.generationStatus ?? 'ok',
    generationStatusScope: initial?.generationStatusScope ?? null,
    statusMessageSafe: initial?.statusMessageSafe ?? null,
    sessionStatus: 'active',
    playbackMode: 'loop-session',
    sessionCoverImageId: initial?.coverImageId ?? null,
    queueLength: 0,
    earlierTracks: 0,
    playableQueueItemIds: [],
    queueItems: [],
    generatingTracksAhead: 0,
    generatingNewVibeTracksAhead: 0,
    pendingGeneration: null,
    styleRevision: null,
    vibe: null,
    switchPending: false,
    tryAgainTracks: null,
    currentFavorited: false,
    currentInCuratedPlaylist: false,
    loopActive: false,
    sourceKind: null,
    activeEdgeTier: null,
    sectionLoopTool: CLOSED_SECTION_LOOP_TOOL,
  };
}

export interface PlaybackControllerApi extends PlaybackControllerState {
  /** 1-based position of the audible track across the whole Session or
   * Playlist — the X in the "Track X/Y" readout. Null while nothing is audible
   * or the track has left the projection (e.g. its dislike rejection landed).
   * Derived per render; the queue poll keeps it fresh. */
  currentTrackNumber: number | null;
  /** The Y in "Track X/Y": every playable Track of the source, the elided
   * ones included. */
  trackCount: number;
  deckARef: React.RefObject<HTMLAudioElement | null>;
  deckBRef: React.RefObject<HTMLAudioElement | null>;
  play: () => void;
  pause: () => void;
  skip: () => void;
  /** Back: restart the current track when it is underway, else step to the
   * previous buffered track. Never a feedback signal (unlike Skip/Dislike). */
  back: () => void;
  /** Step to the previous Track even mid-track (restarting only when none precedes). */
  previous: () => void;
  /** Play the current Track from its start, wherever it is — the half of Back
   * that never leaves the Track. */
  restart: () => void;
  /** The Tracks Skip and `previous` would land on — the cover swipe's preview. */
  peekNeighbors: () => { next: PlayableTrack | null; previous: PlayableTrack | null };
  toggle: () => void;
  /** Dislike the current track: reroll (same vibe) + reject it, then move on. */
  dislike: () => void;
  /** Permanently delete the current Track without recording feedback. */
  deleteTrack: () => void;
  /** After a Delete Track or a removal from the playing Playlist has landed:
   * move past the Track when it is still the audible one (the removal advance,
   * never a Skip), else only drop it from the projection. */
  advancePastDeletedTrack: (trackId: string) => void;
  /** Sync a settled save-picker commit's flags and curated membership onto the
   * current track (retention is membership — the picker sheet is the only save
   * path, and the only write that can move `inCuratedPlaylist`). */
  applyRetentionFlags: (
    trackId: string,
    flags: TrackRetentionFlags,
    inCuratedPlaylist: boolean,
  ) => void;
  /** Toggle Favorite on the current track; Favorite implies Save. */
  toggleFavorite: () => void;
  /** Cycle Loop Session → Loop Track → Shuffle Session. */
  cyclePlaybackMode: () => void;
  /** Select one playback mode outright; the mode it already has is a no-op. */
  setPlaybackMode: (mode: PlaybackMode) => void;
  /** Hard-cut to a playable Queue item. Navigation is never feedback. */
  playQueueItem: (queueItemId: string) => void;
  /** Reflect a committed Rename in the live projection, the held
   * deck tracks, and — for the audible track — the lock-screen metadata, so
   * the new title shows without waiting for the next queue poll. */
  applyTrackTitle: (trackId: string, title: string) => void;
  /** The server-ACKNOWLEDGED generation hold (any live loop lease on the session). */
  loopHeld: boolean;
  /** Whether consecutive Tracks blend at their edges — the persisted playback
   * setting as render state; the engine reads the live value at every edge
   * decision, so a toggle applies to the NEXT transition. */
  blendEnabled: boolean;
  /** Whether `blendEnabled` is the owner's answer yet, or still the default.
   * Anything that decides whether to fade must require this too — the engine
   * gates its own edges the same way, so a saved `blendEnabled: false` cannot
   * lose the race against a transition that starts before the fetch lands. */
  blendSettled: boolean;
  /** Flip blended Track transitions on/off live and persist the choice. */
  toggleBlend: () => void;
  /** Play with the playback settings as stored now, re-read without a write:
   * for a change saved past the player, applied from the next transition. */
  adoptStoredPlaybackSettings: () => void;
  /** Sample the truthful ACTIVE-deck clock (position/duration/rate) — the
   * progress slider's polling read. Stable
   * identity across renders. */
  getPlaybackSample: () => PlaybackSample;
  /** Seek the current Track to `seconds` through the ONE controller funnel —
   * validation, both transports, blend settlement, the immediate report, and
   * the Media Session republish all live inside the player. */
  seekTo: (seconds: number) => void;
  /** Whether the Loop a Part tool can open: a Track is here and the device can run it. */
  sectionLoopAvailable: boolean;
  /** Open the Loop a Part tool, or close it and end any loop. */
  toggleSectionLoopTool: () => void;
  /** Repeat `region` of the audible Track, playing on from `fromSeconds`. */
  setSectionLoop: (region: BufferLoopRegion, fromSeconds: number) => void;
  /** Stop repeating; the audio plays on from where it is. */
  clearSectionLoop: () => void;
  /** Set this controller's whole output level (0..1) — the cross-session
   * handoff's fade handle: the engine's master bus gain when a graph exists,
   * element volume on the sequential fallback. */
  setOutputVolume: (volume: number) => void;
  /** Observe the server Queue now instead of waiting out the adaptive poll
   * delay — the wake-up after Queue-changing mutations (Change Vibe re-engage,
   * Reroll) and for anything else that knows the server moved. No-op under a
   * Playlist source. */
  refreshQueue: () => void;
}
