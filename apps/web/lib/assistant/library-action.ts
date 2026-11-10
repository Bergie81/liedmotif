// What a Library action tool hands back: the receipt when the server did
// something, or only words for the model when it did not.

import type { AssistantReceipt } from '@liedmotif/shared';
import type { ActionOutcome } from './turn-actions';

/** The action was carried out. `told` starts the model's line; the receipt is what the user is shown. */
export const done = (told: string, receipt: AssistantReceipt): ActionOutcome<'done'> => ({
  told: `Done: ${told}`,
  action: { status: 'done', receipt },
});

/** Nothing was changed, and the model is told why. No receipt is sent. */
export const refused = (why: string): ActionOutcome<'done'> => ({
  told: `${why} Nothing was changed.`,
});

/** A tool was given no Track, and the player has none on the deck for "this" to mean. */
export const NO_TRACK_PLAYING =
  'No Track is playing, so "this" names nothing. Ask the user which Track they mean.';

export const NO_SUCH_TRACK = 'No Track with that id.';
export const NO_SUCH_PLAYLIST = 'No Playlist of this user with that id.';
