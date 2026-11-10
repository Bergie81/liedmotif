// What a Library action tool hands back: the receipt when the server did
// something, or only words for the model when it did not.

import type { AssistantPlayerState, AssistantReceipt } from '@liedmotif/shared';
import { receiptNote } from './receipt-note';
import type { ActionOutcome } from './turn-actions';

/**
 * The action was carried out. The model's line is worded from the receipt the
 * user is shown, so the two cannot say different things; `also` adds what the
 * receipt does not carry.
 */
export const done = (receipt: AssistantReceipt, ...also: string[]): ActionOutcome<'done'> => ({
  told: [`Done: ${receiptNote(receipt)}.`, ...also].join(' '),
  action: { status: 'done', receipt },
});

/** Nothing was changed, and the model is told why. No receipt is sent. */
export const refused = (why: string): ActionOutcome<'done'> => ({
  told: `${why} Nothing was changed.`,
});

/**
 * The Tracks a call names, each once, or the one on the player's deck when it
 * names none: "this". Empty when there is neither.
 */
export function askedTracks(
  given: readonly string[] | null | undefined,
  player: AssistantPlayerState | null,
): string[] {
  if (given?.length) return [...new Set(given)];
  return player?.trackId ? [player.trackId] : [];
}

/** A tool was given no Track, and the player has none on the deck for "this" to mean. */
export const NO_TRACK_PLAYING =
  'No Track is playing, so "this" names nothing. Ask the user which Track they mean.';

export const NO_SUCH_TRACK = 'No Track with that id.';
export const NO_SUCH_PLAYLIST = 'No Playlist of this user with that id.';
