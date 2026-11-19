// The queue cursor: the playable projection of the Session Queue, the cursor
// index into it, the loop head that may lead it, and the client-local
// `PlaybackTraversal` layered over it.
//
// It answers what plays next, what plays before, and where the cursor lands
// after a poll or a removal; every decision about what to do with those
// answers stays with the playback controller. It holds the same `PlayableTrack`
// objects the snapshots and decks hold and never copies them: play-settle
// guards compare Tracks by reference. Constructed once per controller.

import {
  nextPlaylistIndex,
  previousPlaylistIndex,
  reanchorPlaylistIndex,
  resolveInitialPlaylistIndex,
  resolveOrderedNextIndex,
} from '@liedmotif/shared';
import type { PlayableTrack, QueueTarget } from './playable-track';
import { PlaybackTraversal } from './playback-traversal';
import { loopHeadLeads, withLeadingLoopHead } from './session-loop-head';

/** The parts of a queue snapshot the projection is built from. */
export interface ProjectionSnapshot {
  /** The Session's first Track when the read window left it out. */
  loopHead: PlayableTrack | null;
  /** The playable Tracks, in normal Session order. */
  tracks: PlayableTrack[];
  /** Every Queue item the snapshot still lists, playable or not. */
  queueItemIds: ReadonlySet<string>;
}

/** Where the stored resume position puts the cursor on the first non-empty load. */
export interface ResumePosition {
  currentQueueItemId: string | null;
  currentTrackId: string | null;
  anchorPosition?: number | null;
}

export class QueueCursor {
  // The playable projection. Queue membership and normal order are
  // authoritative; alternate traversal modes remain client-local.
  tracks: PlayableTrack[] = [];
  idx = 0;
  // The loop head leading the projection, null when none does. It leads so
  // every ordered wrap reaches it the way it reaches index 0.
  loopHeadId: string | null = null;
  readonly traversal = new PlaybackTraversal();
  // Whether the stored resume position has been applied to `idx` yet — done
  // once, on the first non-empty load, so later polls never yank playback backwards.
  private startIndexApplied = false;

  constructor(private readonly expired: (track: PlayableTrack) => boolean) {}

  /** Whether the projection opens with the loop head (a local removal can take it out). */
  headLeads(): boolean {
    return loopHeadLeads(this.tracks, this.loopHeadId);
  }

  /** The index navigation should try next: past the audible Track when it still
   * sits at the cursor, the cursor slot itself when it vanished from the
   * projection (later items shifted left into it) or when nothing is loaded. */
  private nextIndex(audibleId: string | null): number {
    return nextPlaylistIndex(this.tracks, audibleId, this.idx);
  }

  /** The next Track that may start, passing over expired ones and any `skip` rejects. */
  nextTarget(
    audibleId: string | null,
    skip?: (track: PlayableTrack) => boolean,
  ): QueueTarget | null {
    const next = this.nextIndex(audibleId);
    const start = resolveOrderedNextIndex(this.tracks.length, next - 1) ?? 0;
    const target = this.traversal.next(
      this.tracks,
      audibleId,
      start,
      (track) => this.expired(track) || (skip?.(track) ?? false),
    );
    // An ordered advance past the projection's end is the Queue loop restarting;
    // the target carries that so its `started` report can prove the wrap to the
    // server. Shuffle traversal owns its own ordering (the bag) and never wraps.
    if (
      target &&
      this.traversal.mode !== 'shuffle' &&
      (next >= this.tracks.length || target.idx < start)
    ) {
      return { ...target, wrapped: true };
    }
    return target;
  }

  /** The nearest earlier index that may still start, passing over expired
   * offline copies; null when none precedes `from`. */
  previousStartableIndex(from: number): number | null {
    let idx = previousPlaylistIndex(this.tracks, from);
    while (idx != null && this.expired(this.tracks[idx]!)) {
      idx = previousPlaylistIndex(this.tracks, idx);
    }
    // Back stays inside the window: the Tracks between the loop head and
    // the window are not in hand.
    if (idx === 0 && this.headLeads()) return null;
    return idx;
  }

  /** The Track going back would return to, without stepping back. */
  peekPrevious(audibleId: string | null): PlayableTrack | null {
    if (this.traversal.mode === 'shuffle') {
      return this.traversal.peekPrevious(this.tracks, audibleId, this.expired)?.track ?? null;
    }
    const idx = this.previousStartableIndex(this.idx);
    return idx != null ? (this.tracks[idx] ?? null) : null;
  }

  /** Take a Queue item out of the projection and the traversal. */
  remove(queueItemId: string): void {
    this.tracks = this.tracks.filter((t) => t.queueItemId !== queueItemId);
    this.traversal.remove(queueItemId);
  }

  /** Keep the cursor on its Track after the slot at `removedIdx` left the projection. */
  shiftForRemovalAt(removedIdx: number): void {
    if (removedIdx < this.idx) this.idx -= 1;
  }

  /** Replace the projection from a snapshot. `pinnedTrack` is the audible Track
   * a loop holds: it stays in the projection while its Queue item remains. */
  applyProjection(
    snapshot: ProjectionSnapshot,
    pinnedTrack: PlayableTrack | null,
    audibleId: string | null,
  ): PlayableTrack[] {
    const projection = withLeadingLoopHead(snapshot.loopHead, snapshot.tracks);
    this.loopHeadId = projection.loopHeadId;
    let tracks = projection.tracks;
    // A Queue item may remain authoritative while temporarily dropping out of
    // the playable projection (for example while its source availability is
    // being refreshed). Repeat-one pins the already-audible Track, so retain
    // that known-good projection until the raw Queue item actually vanishes.
    if (
      pinnedTrack &&
      snapshot.queueItemIds.has(pinnedTrack.queueItemId) &&
      !tracks.some((track) => track.queueItemId === pinnedTrack.queueItemId)
    ) {
      tracks = [...tracks];
      tracks.splice(Math.min(this.idx, tracks.length), 0, pinnedTrack);
    }
    this.tracks = tracks;
    this.traversal.sync(tracks, audibleId);
    return tracks;
  }

  /** Place the cursor after a projection replaced. On the first non-empty
   * load it lands on the stored resume position: the server's current item,
   * or the next remaining Track after its slot when that Track is gone. Resolved
   * over the whole projection, so the fallback index 0 is the Session's start:
   * the loop head when it leads. Every later poll re-anchors it onto the
   * audible Track instead, since removals shift later indices left. */
  placeCursor(resume: ResumePosition, audibleId: string | null): void {
    if (!this.startIndexApplied && this.tracks.length > 0) {
      this.idx = resolveInitialPlaylistIndex(this.tracks, {
        currentQueueItemId: resume.currentQueueItemId,
        currentTrackId: resume.currentTrackId,
        anchorPosition: resume.anchorPosition,
      });
      this.startIndexApplied = true;
    } else {
      this.idx = reanchorPlaylistIndex(this.tracks, audibleId, this.idx);
    }
  }
}
