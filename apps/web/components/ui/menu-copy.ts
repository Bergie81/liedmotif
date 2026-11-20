// What a menu row says when the same act appears in several menus: the row reads
// the same wherever a listener meets it.

export const MENU_COPY = {
  addTracksFromHistory: 'Pick tracks from your history to add',
  chooseCover: 'Upload an image or generate one',
  editSessionCover: 'Reroll, upload or pick a previous cover',
  choosePlaylists: 'Choose which playlists it belongs to',
  renamePlaylist: 'Give this playlist a new name',
  downloadAllTracks: 'Save all its tracks as a zip file',
  deletePlaylist: 'Delete it for good; tracks only in this playlist leave your library',
} as const;
