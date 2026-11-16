// A receipt in words: the line the chat shows for something the Assistant did
// in the Library or in the user's settings. It is written here from the
// structured values the server sent; the model's own text is never part of it.

import type { AssistantActionItem, AssistantReceipt } from '@liedmotif/shared';
import { trackCount } from '@/lib/assistant/music-names';
import { APP_ROUTES } from '@/lib/assistant/route-map';
import { SETTING_NAMES } from '@/lib/assistant/setting-names';

export interface ReceiptLine {
  /** What was done, as the chat shows it. */
  text: string;
  /** Where the thing now is: a page of the app, and what that place is called. */
  link: { path: string; place: string };
}

export const trackTitle = ({ name }: AssistantActionItem) => name ?? 'Untitled Track';
export const sessionTitle = ({ name }: AssistantActionItem) => name || 'Untitled Session';
const playlistName = ({ name }: AssistantActionItem) => name ?? 'Untitled Playlist';

/** The Playlist's own page; Favorites has one like every other. */
const playlistPage = (playlist: AssistantActionItem) => ({
  path: `/library/playlist/${playlist.id}`,
  place: playlistName(playlist),
});

/** A settings page, under the name the app shows for it. Every setting's page is listed. */
const settingsPage = (path: string) => ({
  path,
  place: APP_ROUTES.find((route) => route.path === path)!.label,
});

/**
 * What the app re-reads after each kind of receipt: the Library's cached pages
 * and the page on screen, only the page on screen, or nothing (the player
 * follows on its own).
 */
export const RECEIPT_REREADS: Record<AssistantReceipt['action'], 'library' | 'page' | 'nothing'> = {
  favoriteTrack: 'library',
  addToPlaylist: 'library',
  createPlaylist: 'library',
  renamePlaylist: 'library',
  pinPlaylist: 'library',
  newMusicOff: 'nothing',
  changeSetting: 'page',
};

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
    case 'changeSetting': {
      const { label, page } = SETTING_NAMES[receipt.setting];
      return {
        text: `${label}: ${receipt.previous} → ${receipt.value}`,
        link: settingsPage(page),
      };
    }
  }
}
