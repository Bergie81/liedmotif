// The loop head: the Session's first playable Track when the queue read's
// window left it out. It leads the projection, so an ordered wrap reaches it
// the way it reaches index 0, while the Track numbering counts it as the
// Session's first Track rather than as the window's.

import type { PlayableTrack } from './playable-track';

/** The projection with the loop head leading it, unless `tracks` already holds
 * it; `loopHeadId` names the head that leads, null when none does. */
export function withLeadingLoopHead(
  loopHead: PlayableTrack | null,
  tracks: PlayableTrack[],
): { tracks: PlayableTrack[]; loopHeadId: string | null } {
  if (!loopHead || tracks.some((track) => track.queueItemId === loopHead.queueItemId)) {
    return { tracks, loopHeadId: null };
  }
  return { tracks: [loopHead, ...tracks], loopHeadId: loopHead.queueItemId };
}

/** Whether the projection opens with the loop head (a local removal can take it out). */
export function loopHeadLeads(
  tracks: readonly PlayableTrack[],
  loopHeadId: string | null,
): boolean {
  return loopHeadId != null && tracks[0]?.queueItemId === loopHeadId;
}

/** The current Track's number and the Track count across the whole Session:
 * the Tracks the read window left out count before the window, after a
 * leading loop head. `currentIndex` is the projection index, -1 when the
 * current Track is not in it. */
export function sessionTrackNumbering(args: {
  currentIndex: number;
  earlierTracks: number;
  projectionLength: number;
  headLeads: boolean;
}): { currentTrackNumber: number | null; trackCount: number } {
  const { currentIndex, earlierTracks, projectionLength, headLeads } = args;
  const lead = headLeads ? 1 : 0;
  const trackNumber = (index: number) =>
    headLeads && index === 0 ? 1 : earlierTracks + index + 1 - lead;
  return {
    currentTrackNumber: currentIndex < 0 ? null : trackNumber(currentIndex),
    trackCount: earlierTracks + projectionLength - lead,
  };
}
