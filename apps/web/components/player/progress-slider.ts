// The progress slider's geometry, pure (the TrackProgress component keeps
// only gesture wiring). Split out when the cold-start stream phase exposed a
// pinned-full bar: a Track playing before its length is known (the provider
// reports durations only once a track is fully rendered) must show an EMPTY
// bar under the explicit unknown form — never a clamped value that reads as
// "played to the end".

import { clamp, resolveSeekTarget } from '@liedmotif/shared';

export interface ProgressSliderShape {
  max: number;
  value: number;
  seekable: boolean;
}

/**
 * What the slider renders for the resolved position/duration. Seekability
 * follows the seek funnel's OWN validation (`resolveSeekTarget`): a duration
 * the funnel would reject as a no-op (unknown, 0 s, shorter than the end
 * guard) yields a disabled, EMPTY bar — elapsed time keeps counting in the
 * label, but the bar claims nothing it doesn't know. A known duration clamps
 * the value into the track bounds (queue metadata can run slightly shorter
 * than the asset — never overshoot the track end).
 */
export function progressSliderShape(
  positionSeconds: number | null,
  durationSeconds: number | null,
): ProgressSliderShape {
  const seekable = resolveSeekTarget(0, durationSeconds) != null;
  if (!seekable || durationSeconds == null) return { max: 1, value: 0, seekable: false };
  return {
    max: durationSeconds,
    value: clamp(positionSeconds ?? 0, 0, durationSeconds),
    seekable: true,
  };
}
