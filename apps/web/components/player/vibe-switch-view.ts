// Client-side derivations for the switch-now Change Vibe: the early-advance
// target after the server cutover, the walk past set-aside queue items, and the
// vibe-boundary queue signals. Pure and DOM-free — these carry the coverage for
// the thin player wiring that applies them.

import type { QueueItem } from '@liedmotif/shared';

/** The projection fields the cutover/advance logic reads. */
interface VibeCutoverEntry {
  queueItemId: string;
  styleRevision: number | null;
  queueState: QueueItem['state'];
}

type VibeStatusEntry = Pick<QueueItem, 'id' | 'position' | 'state' | 'styleRevision'>;

const INITIAL_STYLE_REVISION = 1;

/**
 * The index to jump to when the server cutover lands (`switchPending` falls):
 * the first non-set-aside track at/above the session's revision — or null when
 * nothing is audible (idle cursor logic covers it), the audible track already
 * carries the new vibe, or no new-vibe track is playable yet.
 */
export function resolveVibeCutoverIndex(
  tracks: ReadonlyArray<VibeCutoverEntry>,
  sessionStyleRevision: number | null,
  active: Pick<VibeCutoverEntry, 'styleRevision'> | null,
): number | null {
  if (!active || sessionStyleRevision == null) return null;
  if (active.styleRevision != null && active.styleRevision >= sessionStyleRevision) return null;
  const target = tracks.findIndex(
    (track) =>
      track.queueState !== 'skipped' &&
      track.styleRevision != null &&
      track.styleRevision >= sessionStyleRevision,
  );
  return target >= 0 ? target : null;
}

/**
 * The early-advance decision for one applied poll: a jump target ONLY on the
 * falling edge of `switchPending` (the server just performed the cutover) —
 * one-shot per armed switch by construction. Keeps the edge semantics out of
 * the controller hook; the hook only carries the previous-poll flag.
 */
export function resolveVibeCutoverOnEdge(args: {
  wasSwitchPending: boolean;
  switchPending: boolean;
  tracks: ReadonlyArray<VibeCutoverEntry>;
  sessionStyleRevision: number | null;
  active: Pick<VibeCutoverEntry, 'styleRevision'> | null;
}): number | null {
  if (!args.wasSwitchPending || args.switchPending) return null;
  return resolveVibeCutoverIndex(args.tracks, args.sessionStyleRevision, args.active);
}

/**
 * The up-next list's vibe signals: where the "New vibe from here" divider sits
 * (before the first item at the session's live revision, when anything older
 * precedes it), and whether a vibe change is queued with no arrived track yet.
 */
export function vibeBoundarySignals(
  items: ReadonlyArray<{ id: string; styleRevision: number | null }>,
  sessionStyleRevision: number | null,
): { boundaryBeforeItemId: string | null; changeQueued: boolean } {
  if (sessionStyleRevision == null) return { boundaryBeforeItemId: null, changeQueued: false };
  // Pre-revision Tracks belong to the initial vibe. They become old only after
  // a real Change Vibe advances the Session beyond revision 1.
  const isOld = (revision: number | null) =>
    (revision ?? INITIAL_STYLE_REVISION) < sessionStyleRevision;
  const hasOld = items.some((item) => isOld(item.styleRevision));
  const firstCurrent = items.find((item) => !isOld(item.styleRevision));
  return {
    boundaryBeforeItemId: hasOld && firstCurrent ? firstCurrent.id : null,
    changeQueued: hasOld && !firstCurrent,
  };
}

/** The one caption every in-flight narration (the player's status line, the
 * mini player) shares. */
export const VIBE_CHANGE_PENDING_CAPTION = 'Changing vibe…';

const UPCOMING_QUEUE_STATES = new Set<QueueItem['state']>(['planned', 'generating', 'queued']);

/**
 * The Change Vibe narration the player's status line shows, from the request
 * until the new vibe plays. Past the request it is derived from the live
 * Session revision and authoritative Queue, so it survives remounts.
 */
export function presentVibeChangeCaption(args: {
  items: ReadonlyArray<VibeStatusEntry>;
  currentTrackStyleRevision: number | null;
  sessionStyleRevision: number | null;
  /** In-flight Tracks whose generation request carries the Session's live
   * revision. A Session that never changed vibe reports its ordinary top-ups
   * here too, so this may only be read as "the new vibe is on its way" once
   * the Queue itself shows a change happened. */
  generatingNewVibeTracksAhead: number;
  /** The Change Vibe request is still in flight (no new revision exists yet). */
  requestPending?: boolean;
  /** A switch-now Change Vibe is armed server-side: the cutover comes with the
   * first playable new-vibe Track. */
  switchPending?: boolean;
}): string | null {
  // Checked first: while the request is in flight the session revision still
  // matches the audible track, which silences every revision-based branch.
  if (args.requestPending) return VIBE_CHANGE_PENDING_CAPTION;
  if (args.switchPending) return 'Switching to the new vibe…';
  const targetRevision = args.sessionStyleRevision;
  const orderedItems = [...args.items].sort((a, b) => a.position - b.position);
  const newVibeIsAudible =
    targetRevision != null &&
    args.currentTrackStyleRevision != null &&
    args.currentTrackStyleRevision >= targetRevision;
  if (newVibeIsAudible) return null;

  // Only a slot the listener has yet to reach says the new vibe is ahead: one
  // that already played or lost its audio is behind the listener. A slot with
  // no revision at all predates revision tracking, so it belongs to the
  // initial vibe however far the Session's revision has moved. A change
  // happened only when the Queue holds an older slot: with no Track loaded (a
  // cold start), a Session's own first slots are not a new vibe.
  const changeShown =
    targetRevision != null &&
    orderedItems.some((item) => (item.styleRevision ?? INITIAL_STYLE_REVISION) < targetRevision);
  const newVibeAhead = orderedItems.some(
    (item) =>
      changeShown &&
      targetRevision != null &&
      item.styleRevision != null &&
      item.styleRevision >= targetRevision &&
      UPCOMING_QUEUE_STATES.has(item.state),
  );
  if (newVibeAhead) return 'New vibe queued';
  // Nothing has arrived: the Queue's own revisions must show a change happened
  // at all, and only the server's in-flight count can promise Tracks — a fill
  // refused after the revision bumped is not coming.
  if (args.generatingNewVibeTracksAhead === 0) return null;
  if (!vibeBoundarySignals(orderedItems, targetRevision).changeQueued) return null;
  return 'Queuing new vibe…';
}
