import {
  commitShuffleTarget,
  createShuffleState,
  cyclePlaybackMode,
  peekShuffleTarget,
  popShuffleHistory,
  removeShuffleTrack,
  syncShuffleState,
  type PlaybackMode,
  type ShuffleState,
} from '@liedmotif/shared';
import type { PlayableTrack, QueueTarget } from './playable-track';

export type ShuffleTransition = 'record' | 'discard' | 'preserve';

/** Owns the client-local traversal state layered over authoritative Queue membership. */
export class PlaybackTraversal {
  private currentMode: PlaybackMode = 'loop-session';
  private shuffleState: ShuffleState = createShuffleState([], null);

  get mode(): PlaybackMode {
    return this.currentMode;
  }

  select(
    mode: PlaybackMode,
    tracks: readonly PlayableTrack[],
    currentQueueItemId: string | null,
  ): void {
    this.currentMode = mode;
    this.shuffleState =
      mode === 'shuffle'
        ? createShuffleState(idsOf(tracks), currentQueueItemId)
        : createShuffleState([], null);
  }

  nextMode(): PlaybackMode {
    return cyclePlaybackMode(this.currentMode);
  }

  /** The next target, passing over every Track `skip` rejects (ordered
   * traversal wraps to reach them); null when no candidate is left. */
  next(
    tracks: readonly PlayableTrack[],
    currentQueueItemId: string | null,
    orderedIndex: number,
    skip: (track: PlayableTrack) => boolean = () => false,
  ): QueueTarget | null {
    if (this.currentMode !== 'shuffle') {
      for (let step = 0; step < tracks.length; step += 1) {
        const target = targetAt(tracks, (orderedIndex + step) % tracks.length);
        if (target && !skip(target.track)) return target;
      }
      return null;
    }

    // A skipped pick leaves the bag as a visited one would. A drained bag
    // refills with every candidate once, so two bags' worth of picks reach
    // every candidate `skip` accepts.
    for (let pick = 0; pick <= 2 * tracks.length; pick += 1) {
      const peeked = peekShuffleTarget(this.shuffleState, idsOf(tracks), currentQueueItemId);
      this.shuffleState = peeked.state;
      const target = targetById(tracks, peeked.queueItemId);
      if (!target || !skip(target.track)) return target;
      this.shuffleState = commitShuffleTarget(this.shuffleState, null, target.track.queueItemId);
    }
    return null;
  }

  commit(
    outgoingQueueItemId: string | null,
    targetQueueItemId: string,
    transition: ShuffleTransition = 'record',
  ): void {
    if (this.currentMode !== 'shuffle' || transition === 'preserve') return;
    if (transition === 'discard' && outgoingQueueItemId) {
      this.shuffleState = removeShuffleTrack(this.shuffleState, outgoingQueueItemId);
    }
    this.shuffleState = commitShuffleTarget(
      this.shuffleState,
      transition === 'record' ? outgoingQueueItemId : null,
      targetQueueItemId,
    );
  }

  previous(
    tracks: readonly PlayableTrack[],
    currentQueueItemId: string | null,
  ): QueueTarget | null {
    if (this.currentMode !== 'shuffle') return null;
    const target = popShuffleHistory(this.shuffleState, idsOf(tracks), currentQueueItemId);
    this.shuffleState = target.state;
    return targetById(tracks, target.queueItemId);
  }

  /** The Track `previous` would return to, without stepping back, passing
   * over every Track `skip` rejects. */
  peekPrevious(
    tracks: readonly PlayableTrack[],
    currentQueueItemId: string | null,
    skip: (track: PlayableTrack) => boolean = () => false,
  ): QueueTarget | null {
    if (this.currentMode !== 'shuffle') return null;
    let state = this.shuffleState;
    for (;;) {
      const popped = popShuffleHistory(state, idsOf(tracks), currentQueueItemId);
      const target = targetById(tracks, popped.queueItemId);
      if (!target || !skip(target.track)) return target;
      state = popped.state;
    }
  }

  remove(queueItemId: string): void {
    this.shuffleState = removeShuffleTrack(this.shuffleState, queueItemId);
  }

  sync(tracks: readonly PlayableTrack[], currentQueueItemId: string | null): void {
    if (this.currentMode !== 'shuffle') return;
    this.shuffleState = syncShuffleState(this.shuffleState, idsOf(tracks), currentQueueItemId);
  }
}

function idsOf(tracks: readonly PlayableTrack[]): string[] {
  return tracks.map((track) => track.queueItemId);
}

function targetAt(tracks: readonly PlayableTrack[], index: number): QueueTarget | null {
  const track = tracks[index];
  return track ? { idx: index, track } : null;
}

function targetById(
  tracks: readonly PlayableTrack[],
  queueItemId: string | null,
): QueueTarget | null {
  if (!queueItemId) return null;
  return targetAt(
    tracks,
    tracks.findIndex((track) => track.queueItemId === queueItemId),
  );
}
