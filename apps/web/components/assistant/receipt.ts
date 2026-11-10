// A receipt in words: the line the chat shows for something the Assistant did
// in the Library. It is written here from the structured values the server
// sent; the model's own text is never part of it.

import type { AssistantActionItem, AssistantReceipt } from '@liedmotif/shared';
import { trackCount } from '@/lib/assistant/music-names';

export interface ReceiptLine {
  /** What was done, as the chat shows it. */
  text: string;
  /** Where the thing now is: a page of the app, and what that place is called. */
  link: { path: string; place: string };
}

const trackTitle = ({ name }: AssistantActionItem) => name ?? 'Untitled Track';
const sessionTitle = ({ name }: AssistantActionItem) => name || 'Untitled Session';
const playlistName = ({ name }: AssistantActionItem) => name ?? 'Untitled Playlist';

/** The Playlist's own page; Favorites has one like every other. */
const playlistPage = (playlist: AssistantActionItem) => ({
  path: `/library/playlist/${playlist.id}`,
  place: playlistName(playlist),
});

/** Whether what was done changed what the Library's pages list. */
export const receiptChangesLibrary = (receipt: AssistantReceipt) =>
  receipt.action !== 'newMusicOff';

export function receiptLine(receipt: AssistantReceipt): ReceiptLine {
  switch (receipt.action) {
    case 'favoriteTrack':
      return {
        text: `Added to Favorites: ${trackTitle(receipt.track)}`,
        link: playlistPage(receipt.playlist),
      };
    case 'addToPlaylist': {
      const [first] = receipt.tracks;
      const to = playlistName(receipt.playlist);
      return {
        text:
          receipt.tracks.length === 1 && first
            ? `Added to ${to}: ${trackTitle(first)}`
            : `Added ${trackCount(receipt.tracks.length)} to ${to}`,
        link: playlistPage(receipt.playlist),
      };
    }
    case 'createPlaylist':
      return {
        text: `Created Playlist: ${playlistName(receipt.playlist)}`,
        link: playlistPage(receipt.playlist),
      };
    case 'renamePlaylist':
      return {
        text: `Renamed Playlist: ${receipt.previousName} → ${playlistName(receipt.playlist)}`,
        link: playlistPage(receipt.playlist),
      };
    case 'pinPlaylist':
      return {
        text: `Pinned Playlist: ${playlistName(receipt.playlist)}`,
        // A pin shows in the list it reorders, not on the Playlist's own page.
        link: { path: '/library', place: 'Library' },
      };
    case 'newMusicOff':
      return {
        text: `New music off: ${sessionTitle(receipt.session)}`,
        link: { path: '/player', place: 'Now Playing' },
      };
  }
}
