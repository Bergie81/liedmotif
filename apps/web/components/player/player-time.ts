// Player time display formatting.

/** The progress display's explicit unknown form — never a misleading `0:00`. */
export const UNKNOWN_PLAYER_TIME = '–:––';

/** Format a playback time as `m:ss` (or `h:mm:ss` from an hour up); unusable
 * input (null, non-finite, negative) renders the unknown form. */
export function formatPlayerTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return UNKNOWN_PLAYER_TIME;
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
