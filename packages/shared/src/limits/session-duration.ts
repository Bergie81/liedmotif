// The Session duration target counts usable generated music, never listening
// time. One predicate, so the worker's admission, the Change Vibe
// refusal, and the player all agree on when the target is met.

/** At or above the target, every fresh music-model purchase is blocked. */
export function isDurationTargetReached(
  targetMinutes: number | null | undefined,
  generatedSeconds: number | null | undefined,
): boolean {
  return targetMinutes != null && (generatedSeconds ?? 0) >= targetMinutes * 60;
}

/** Why a creative Change Vibe is refused at the target, and the way out. */
export const DURATION_TARGET_REACHED_MESSAGE =
  'Duration target reached — this Session repeats its Tracks. Raise or clear the target to hear a new vibe.';
