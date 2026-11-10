// A receipt as the model reads it. The tool that did the thing answers with
// this sentence, and the chat panel sends it back with the answer it happened
// in, so the model reads one wording of an action in the turn that did it and
// in every later one. Plain text, safe to import from the browser.

import type { AssistantActionItem, AssistantReceipt } from '@liedmotif/shared';
import { named, quoted, trackCount } from './music-names';

const playlist = ({ name, id }: AssistantActionItem) => `the Playlist ${named(name, id)}`;
const track = ({ name, id }: AssistantActionItem) => `the Track ${named(name, id)}`;

/** What was done, to what: each thing by its name and the id the tools take for it. */
export function receiptNote(receipt: AssistantReceipt): string {
  switch (receipt.action) {
    case 'favoriteTrack':
      return `added ${track(receipt.track)} to Favorites`;
    case 'addToPlaylist': {
      const [first] = receipt.tracks;
      const what =
        receipt.tracks.length === 1 && first ? track(first) : trackCount(receipt.tracks.length);
      return `added ${what} to ${playlist(receipt.playlist)}`;
    }
    case 'createPlaylist':
      return `created ${playlist(receipt.playlist)}`;
    case 'renamePlaylist':
      return `renamed the Playlist ${quoted(receipt.previousName)} to ${named(receipt.playlist.name, receipt.playlist.id)}`;
    case 'pinPlaylist':
      return `pinned ${playlist(receipt.playlist)}`;
    case 'newMusicOff':
      return `switched New music off for the Session ${named(receipt.session.name, receipt.session.id)}`;
  }
}
