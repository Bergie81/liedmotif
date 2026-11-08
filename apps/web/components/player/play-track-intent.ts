// How a tapped track row plays (pure decision, UI-free): the audible Track
// pauses/resumes in place whichever source is playing it; any other Track is
// selected through its origin Session, with the page-local preview reserved for
// tracks whose Session was deleted.

export interface TrackPlayTarget {
  id: string;
  originSessionId: string | null;
}

export type TrackPlayIntent =
  /** Already the audible Track, from any source — pause/resume in place. */
  | { kind: 'toggle' }
  /** No origin Session — the surface's page-local preview is all there is. */
  | { kind: 'preview' }
  /** Validate and position the selected Track server-side before playing it. */
  | { kind: 'select'; sessionId: string };

export function resolveTrackPlayIntent(
  track: TrackPlayTarget,
  audibleTrackId: string | null,
): TrackPlayIntent {
  if (audibleTrackId === track.id) return { kind: 'toggle' };
  if (!track.originSessionId) return { kind: 'preview' };
  return { kind: 'select', sessionId: track.originSessionId };
}
