// A Player act that did not land (a Dislike, a Favorite, a Change Vibe, a
// delete) is an error toast raised when it fails, wherever the listener is. It
// is keyed by the source it happened on and the act, so trying the act again
// clears it, and the source leaving the player takes its failures with it.

import { dismissToastsKeyedWith, toast } from '@/lib/toast';

export type PlayerAct =
  | 'blend'
  | 'change-vibe'
  | 'convert-to-playlist'
  | 'delete-playlist'
  | 'delete-session'
  | 'delete-track'
  | 'dislike'
  | 'favorite'
  | 'loop-hold'
  | 'more-like-this'
  | 'remove-from-playlist'
  | 'section-loop'
  | 'stop';

/** `sourceId` is the engaged source's id (`engagedSourceId`). */
function keyOf(sourceId: string, act?: PlayerAct): string {
  return `player-error:${sourceId}:${act ?? ''}`;
}

export function showPlayerError(sourceId: string, act: PlayerAct, message: string): void {
  toast.error(message, { key: keyOf(sourceId, act) });
}

/** The act is being tried again: its earlier failure no longer stands. */
export function clearPlayerError(sourceId: string, act: PlayerAct): void {
  toast.dismiss(keyOf(sourceId, act));
}

export function clearPlayerErrors(sourceId: string): void {
  dismissToastsKeyedWith(keyOf(sourceId));
}
