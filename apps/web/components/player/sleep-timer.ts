// The Sleep Timer: stop the music after a chosen time. It is a playback
// convenience, not a Session or Playlist setting — one timer for whatever is
// playing, held by the player provider so it survives navigation and source
// handoffs, and gone on reload.

export const SLEEP_TIMER_MIN_MINUTES = 5;
export const SLEEP_TIMER_MAX_MINUTES = 90;
export const SLEEP_TIMER_STEP_MINUTES = 5;
export const SLEEP_TIMER_DEFAULT_MINUTES = 30;

/** The music fades out over the timer's last seconds, so it is silent — not
 *  just starting to fade — at the time the listener chose. */
export const SLEEP_TIMER_FADE_MS = 10_000;

const MINUTE_MS = 60_000;

/** The one running timer, as the player provider offers it. */
export interface SleepTimerControl {
  /** When the music fades to silence (epoch ms), or null while off. */
  endsAt: number | null;
  /** Set the timer to `minutes` from now, replacing any running one. */
  start: (minutes: number) => void;
  cancel: () => void;
}

export function sleepTimerEndsAt(minutes: number, now: number): number {
  return now + minutes * MINUTE_MS;
}

/** The whole minutes left, never 0 while the music still fades out. */
export function sleepTimerMinutesLeft(endsAt: number | null, now: number): number | null {
  if (endsAt === null) return null;
  return Math.max(1, Math.ceil((endsAt - now) / MINUTE_MS));
}

/** The row's note: what is left of a running timer. */
export function sleepTimerNote(endsAt: number | null, now: number): string | undefined {
  const minutes = sleepTimerMinutesLeft(endsAt, now);
  return minutes === null ? undefined : `${minutes} min left`;
}
