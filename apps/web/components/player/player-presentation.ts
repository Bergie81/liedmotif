import {
  clamp,
  COVER_THUMBNAIL_EDGE,
  PLACEHOLDER_COVER_ID,
  type CommittedSourceKind,
  type PlaybackMode,
  type QueueItem,
} from '@liedmotif/shared';
import { formatGenreLine } from '@/components/sessions/session-list-model';
import type { PlaybackSample, PlayerStatus } from './playback-controller-api';
import type { PlayableTrack } from './playable-track';
import type { VibeChangeState } from './use-vibe-change-request';
import { VIBE_CHANGE_PENDING_CAPTION } from './vibe-switch-view';

/** The status line of a Playlist or an Offline Library collection, each of which
 * adds its own kind after it. A Session names itself instead. */
export const PLAYER_STATUS_LABEL: Record<PlayerStatus, string> = {
  loading: 'Connecting',
  ready: 'Ready',
  playing: 'Now Playing',
  paused: 'Paused',
  waiting: 'Preparing',
  ended: 'Ended',
};

/** The status line above a Session's title. Not the Session status, which is the
 * progress slider's note on what the Session is doing. */
export const SESSION_PLAYER_STATUS_LABEL: Record<PlayerStatus, string> = {
  ...PLAYER_STATUS_LABEL,
  waiting: 'Preparing Your Session',
  ended: 'Session Ended',
};

/** The engaged Playback source as the player's copy says it — the
 * noun a shared surface drops into its own wording. This is copy, not the
 * `source.kind` discriminator the player state carries. */
export type SourceNoun = 'Session' | 'Playlist';

/** The transport opens the engaged source's Track collection. */
export const QUEUE_LABEL: Record<SourceNoun, string> = {
  Session: 'Tracks in This Session',
  Playlist: 'Tracks in This Playlist',
};

export interface MiniPlayerPresentation {
  title: string;
  subtitle: string;
}

export type PlaybackModeIcon = 'repeat' | 'repeat-one' | 'shuffle';

export interface PlaybackModePresentation {
  label: string;
  nextLabel: string;
  icon: PlaybackModeIcon;
  highlighted: boolean;
}

function playbackModePresentation(
  noun: SourceNoun,
): Record<PlaybackMode, PlaybackModePresentation> {
  return {
    'loop-session': {
      label: `Loop ${noun}`,
      nextLabel: 'Loop Track',
      icon: 'repeat',
      highlighted: false,
    },
    'loop-track': {
      label: 'Loop Track',
      nextLabel: `Shuffle ${noun}`,
      icon: 'repeat-one',
      highlighted: true,
    },
    shuffle: {
      label: `Shuffle ${noun}`,
      nextLabel: `Loop ${noun}`,
      icon: 'shuffle',
      highlighted: true,
    },
  };
}

const PLAYBACK_MODE_PRESENTATION = playbackModePresentation('Session');
const PLAYLIST_PLAYBACK_MODE_PRESENTATION = playbackModePresentation('Playlist');

/** Shared copy and visual state for every playback-mode switch surface. The
 * mechanics are identical across sources; only the noun changes. */
export function presentPlaybackMode(
  mode: PlaybackMode,
  sourceNoun: SourceNoun = 'Session',
): PlaybackModePresentation {
  return (
    sourceNoun === 'Playlist' ? PLAYLIST_PLAYBACK_MODE_PRESENTATION : PLAYBACK_MODE_PRESENTATION
  )[mode];
}

/** The mini player's two text lines (sidebar rail on desktop, bottom bar on
 * mobile): the audible track — or, before one, the pending track or the
 * source's own name — over the Session or Playlist it plays from. */
export function presentMiniPlayer(input: {
  sourceTitle: string | null;
  sourceNoun: SourceNoun;
  track: { title: string | null } | null;
  pendingTrackTitle: string | null;
  sectionLooping: boolean;
}): MiniPlayerPresentation {
  const sourceName = input.sourceTitle ?? `Untitled ${input.sourceNoun}`;
  const title = input.track?.title ?? input.pendingTrackTitle ?? sourceName;
  // A Track that will not move on by itself is worth saying, off the player page.
  if (input.sectionLooping) return { title, subtitle: 'Looping a part' };
  // The second line always names where the music comes from; when the title is
  // already that name, it says what kind of source it is instead.
  return { title, subtitle: title === sourceName ? input.sourceNoun : sourceName };
}

/** The mini player's Change Vibe note — the cross-route surface, so an
 * in-flight or failed request stays visible while the user is off /player.
 * Scoped to the live session; the full player carries the richer narration. */
export function presentMiniVibeChange(
  vibeChange: VibeChangeState,
  sessionId: string | null,
): { text: string; tone: 'progress' | 'error' } | null {
  if (!sessionId) return null;
  if (vibeChange.pendingSessionId === sessionId) {
    return { text: VIBE_CHANGE_PENDING_CAPTION, tone: 'progress' };
  }
  if (vibeChange.error?.sessionId === sessionId) {
    return { text: 'Change Vibe failed — open to retry', tone: 'error' };
  }
  return null;
}

/** A Playback source on its way to replace the audible one: a Session whose
 * start request is still in flight (`connecting` — no Session exists yet), or
 * a Session or Playlist arming behind the current playback (`preparing`, the
 * dual-host handoff). */
export type IncomingSource =
  { stage: 'connecting' } | { stage: 'preparing'; noun: SourceNoun; title: string | null };

function incomingNoun(incoming: IncomingSource): SourceNoun {
  return incoming.stage === 'connecting' ? 'Session' : incoming.noun;
}

/** The cover chip's narration for an incoming source over the `playing` one.
 * `chip` is the visible mono micro-copy; `detail` carries the reassurance
 * (playback continues) for assistive tech and the hover title — too long for
 * the chip itself. */
export function presentIncomingSource(
  incoming: IncomingSource,
  playing: SourceNoun,
): {
  chip: string;
  detail: string;
} {
  return {
    chip:
      incoming.stage === 'connecting'
        ? 'Setting the vibe…'
        : incoming.title
          ? `Preparing “${incoming.title}”…`
          : `Preparing your next ${incoming.noun.toLowerCase()}…`,
    detail: `This ${playing.toLowerCase()} keeps playing until the new one is ready.`,
  };
}

/** The one Delete Session confirmation, shared by every surface that offers the
 * action — the options sheet's row and the stuck zero-track banner's way out: a
 * destructive action asks the same question wherever it is reached from. */
export function deleteSessionConfirm(sessionTitle: string): {
  heading: string;
  body: string;
  confirmLabel: string;
} {
  return {
    heading: 'Delete Session',
    body: `Permanently delete “${sessionTitle}”? The session stops first; its tracks are deleted unless saved to a playlist — saved tracks stay in your Library.`,
    confirmLabel: 'Delete',
  };
}

export type QueueItemPresentationKind =
  'played' | 'current' | 'ready' | 'waiting' | 'generating' | 'failed';

export interface QueueItemPresentation {
  kind: QueueItemPresentationKind;
  label: string;
  asset: 'final' | 'stream' | null;
}

/** The status line's genre readout, capped at three tags so a free-text
 * session's LLM-derived tag list cannot flood the line. Null when the track
 * has none. */
export function presentTrackGenres(genreTags: readonly string[]): string | null {
  return formatGenreLine(genreTags.slice(0, 3));
}

export function presentSource(sourceKind: CommittedSourceKind | null): {
  label: string;
  detail: string;
} | null {
  if (sourceKind === 'stream') {
    return { label: 'Live Stream', detail: 'Local final on the way' };
  }
  if (sourceKind === 'final') {
    return { label: 'Local Final', detail: 'Stored locally' };
  }
  return null;
}

/** Artwork precedence shared by the player surfaces: the live Session Cover
 * (queue poll) wins, then the mount summary's cover, then the track's own. */
export function resolveCoverImageId(
  player: {
    sessionCoverImageId: string | null;
    currentTrack: { coverImageId: string | null } | null;
  },
  /** Null while a Playlist plays: no shared cover, per-track art always wins
   *  (a Session Cover outranks track art). */
  session: { coverImageId: string | null } | null,
): string | null {
  return (
    player.sessionCoverImageId ?? session?.coverImageId ?? player.currentTrack?.coverImageId ?? null
  );
}

/** A neighbor's artwork; `coverImageId: null` is the placeholder art. */
export interface CoverPeek {
  coverImageId: string | null;
}

export interface SwipeNeighbors {
  next: CoverPeek | null;
  previous: CoverPeek | null;
}

/** The artwork a cover swipe reveals, by the same precedence as the playing
 * cover. Skip always moves — to the next Track, or to waiting for one — so a
 * next side always shows; nothing shows before the first Track. */
export function presentSwipeNeighbors(
  player: {
    sessionCoverImageId: string | null;
    peekNeighbors: () => { next: PlayableTrack | null; previous: PlayableTrack | null };
  },
  session: { coverImageId: string | null } | null,
): SwipeNeighbors {
  const { next, previous } = player.peekNeighbors();
  const coverOf = (track: PlayableTrack | null) => ({
    coverImageId: resolveCoverImageId(
      { sessionCoverImageId: player.sessionCoverImageId, currentTrack: track },
      session,
    ),
  });
  return { next: coverOf(next), previous: previous ? coverOf(previous) : null };
}

/** Whether a cover id shows the built-in placeholder art: a fresh Session's
 * stored placeholder cover, or no cover at all (which `coverArtSrc` resolves to
 * the same art). */
export function isPlaceholderCover(coverImageId: string | null): boolean {
  return coverImageId === null || coverImageId === PLACEHOLDER_COVER_ID;
}

/** Same-origin cover URL for an opaque cover id. A missing id resolves to the
 * built-in placeholder art via the route's reserved `placeholder` segment —
 * player surfaces always show cover art, never a bare icon. `thumb` asks the
 * route for the downscaled tile rendition (list rows, sheet headers) instead of
 * the ~150 KB full-size original. */
export function coverArtSrc(coverImageId: string | null, size: 'full' | 'thumb' = 'full'): string {
  const base = `/api/covers/${coverImageId ?? 'placeholder'}`;
  return size === 'thumb' ? `${base}?w=${COVER_THUMBNAIL_EDGE}` : base;
}

/** Assumed length of a still-streaming track whose real duration the provider
 * has not reported yet — a typical generation runs a few minutes. */
const ESTIMATED_STREAM_DURATION_SECONDS = 180;
/** An estimated bar must keep visibly moving yet never read as finished; it
 * parks here until the real length lands (or the track actually ends). */
const ESTIMATED_PROGRESS_CAP_PERCENT = 95;

/** A length is usable as the bar's denominator only when it is a real, finite
 * number of seconds — a length-less stream reports null, 0, or Infinity. */
function usableDuration(seconds: number | null | undefined): number | null {
  return seconds != null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function playbackProgressPercent(
  sample: PlaybackSample,
  /** Queue-known track length, the fallback while the live clock is length-less
   * (the element plays a length-less stream until the final asset loads). */
  knownDurationSeconds: number | null,
): number {
  const { positionSeconds } = sample;
  if (positionSeconds == null || !Number.isFinite(positionSeconds)) return 0;
  const known = usableDuration(sample.durationSeconds) ?? usableDuration(knownDurationSeconds);
  // A known length may run the bar to the end; an assumed one parks short of it.
  const [durationSeconds, ceiling] =
    known != null
      ? ([known, 100] as const)
      : ([ESTIMATED_STREAM_DURATION_SECONDS, ESTIMATED_PROGRESS_CAP_PERCENT] as const);
  const percent = clamp((positionSeconds / durationSeconds) * 100, 0, ceiling);
  // Quantized to 0.1% — below any bar's pixel resolution — so a paused clock
  // (or a sub-step tick) yields the SAME number and React bails out of the
  // re-render instead of repainting every poll.
  return Math.round(percent * 10) / 10;
}

export function presentQueueItem(
  item: QueueItem,
  currentQueueItemId: string | null,
  currentSourceKind: CommittedSourceKind | null = null,
): QueueItemPresentation {
  if (item.id === currentQueueItemId || (currentQueueItemId == null && item.state === 'playing')) {
    return {
      kind: 'current',
      label: 'Now playing',
      asset:
        item.id === currentQueueItemId && currentSourceKind
          ? currentSourceKind
          : item.assets.final
            ? 'final'
            : item.assets.stream
              ? 'stream'
              : null,
    };
  }
  if (item.state === 'played' || item.state === 'skipped' || item.state === 'rejected') {
    return { kind: 'played', label: 'Earlier', asset: null };
  }
  if (item.state === 'failed') {
    return { kind: 'failed', label: 'Generation failed', asset: null };
  }
  if (item.assets.final) {
    return { kind: 'ready', label: 'Ready · final', asset: 'final' };
  }
  if (item.assets.stream) {
    return { kind: 'ready', label: 'Ready · stream', asset: 'stream' };
  }
  if (item.state === 'generating' || item.state === 'planned') {
    return { kind: 'generating', label: 'Generating', asset: null };
  }
  return { kind: 'waiting', label: 'Waiting for audio', asset: null };
}

export interface SessionActivity {
  label: string;
  /** `active` is work under way (tinted, the rail breathes); `muted` is a
   * calm state that explains why nothing is happening. */
  tone: 'active' | 'muted';
}

/** What the Session is doing, as the slider's status after the Track number.
 * An incoming source outranks everything (it IS what plays next), then the
 * Change Vibe the listener asked for, then the Tracks on the way. Repeat
 * explains why nothing generates, so it shows only while nothing does. Null
 * when the Session is idle: the status never claims work that is not
 * happening. */
export function presentSessionActivity(input: {
  incoming: IncomingSource | null;
  /** The Change Vibe narration (`presentVibeChangeCaption`). */
  vibeChangeCaption: string | null;
  sessionRepeat: boolean;
  generatingAhead: number;
}): SessionActivity | null {
  if (input.incoming) return { label: `Next ${incomingNoun(input.incoming)}`, tone: 'active' };
  if (input.vibeChangeCaption) return { label: input.vibeChangeCaption, tone: 'active' };
  if (input.generatingAhead > 0) {
    return { label: `Generating ${input.generatingAhead}`, tone: 'active' };
  }
  return input.sessionRepeat ? { label: 'Repeat', tone: 'muted' } : null;
}

/** Tracks on the way: what the server's in-flight provider jobs still owe plus
 * the Queue slots ahead of the audible one that hold no playable asset yet.
 * A consumed slot — played, skipped, or rejected by a Dislike — is never on
 * the way. With no audible slot, every slot is ahead. */
export function countGeneratingAhead(input: {
  items: readonly QueueItem[];
  currentQueueItemId: string | null;
  /** Tracks the server's in-flight provider jobs still owe, none of which has
   * reached the Queue as a slot yet. */
  generatingTracksAhead: number;
}): number {
  const kinds = [...input.items]
    .sort((a, b) => a.position - b.position)
    .map((item) => presentQueueItem(item, input.currentQueueItemId).kind);
  const ahead = kinds.slice(kinds.indexOf('current') + 1);
  // A slot that arrived without a playable asset is still on the way, and the
  // server already subtracted it from its job's in-flight expectation.
  return (
    input.generatingTracksAhead +
    ahead.filter((kind) => kind === 'waiting' || kind === 'generating').length
  );
}
