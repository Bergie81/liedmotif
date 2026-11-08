// Seek-target validation.
//
// The one place seek targets are validated and clamped — the controller seek
// funnel and every caller go through it, so nothing negative, non-finite, or
// beyond-duration can reach `currentTime`, Web Audio, or the nonnegative
// report schema. Framework-/DOM-free so the decision carries unit coverage
// while the players stay thin.

import { clamp } from './blend';

/** The end guard (seconds): targets clamp to `duration − guard`, so the seek
 *  COMMIT itself never fires a synchronous `ended`/advance — a near-end seek
 *  then plays out as an ordinary natural end (never a `skipped` report). */
export const SEEK_END_GUARD_SECONDS = 0.3;

/**
 * The validated seek target, or `null` for "no seek" (zero side effects):
 *
 * - Non-finite raw input (a Media Session `seekTime` is UA-supplied and
 *   untrusted) → `null`.
 * - Unknown, non-finite, zero, or shorter-than-guard duration → `null` — with
 *   no trustworthy duration there is no clamp target, and a degenerate
 *   duration can never produce an empty or inverted clamp interval.
 * - Otherwise the target clamped to `[0, duration − guard]`.
 */
export function resolveSeekTarget(
  rawSeconds: number,
  durationSeconds: number | null,
): number | null {
  if (!Number.isFinite(rawSeconds)) return null;
  if (
    durationSeconds == null ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= SEEK_END_GUARD_SECONDS
  ) {
    return null;
  }
  return clamp(rawSeconds, 0, durationSeconds - SEEK_END_GUARD_SECONDS);
}
