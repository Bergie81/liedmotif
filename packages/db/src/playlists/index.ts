// Playlists domain barrel: playlist CRUD,
// membership writes (the retention chokepoint), and the owner-scoped reads.
export {
  addPlaylistTracks,
  applyTrackMemberships,
  convertSessionToPlaylist,
  createPlaylist,
  deletePlaylist,
  ensureFavoritesPlaylist,
  FAVORITES_PLAYLIST_NAME,
  removePlaylistTrack,
  renamePlaylist,
  setPlaylistOrder,
  setTrackFavorited,
  touchPlaylistPlayed,
  unsaveTrackEverywhere,
  type AddPlaylistTracksResult,
  type ApplyTrackMembershipsResult,
  type ConvertSessionToPlaylistResult,
  type PlaylistManageResult,
  type PlaylistRow,
} from './playlists-repo';
export {
  getPlaylistDetail,
  listPlaylists,
  listPlaylistsPage,
  type ListPlaylistsPageResult,
  type PlaylistDetailResult,
  type PlaylistMemberTrack,
  type PlaylistSummary,
} from './playlist-reads';
export {
  getPlaylistShare,
  moderateLoungePlaylistToPrivate,
  setPlaylistShared,
  type PlaylistShareState,
} from './playlist-share-repo';
export {
  getOwnedPlaylistDownloadTracks,
  type PlaylistDownloadTracks,
} from './playlist-download-repo';
export { isCoverLoungeVisible, trackIsLoungeAudible, viewerCanReadTrack } from './lounge-audible';
export { type OwnerAttribution } from './owner-attribution';
export {
  isPlaylistLoungePinned,
  setPlaylistLibraryPinned,
  setPlaylistLoungePinned,
} from './pins-repo';
export {
  getLoungePlaylistDetail,
  listLoungePlaylistsPage,
  listLoungeSharers,
  type ListLoungePlaylistsPageResult,
  type LoungeMatch,
  type LoungeOwner,
  type LoungePlaylistDetailResult,
  type LoungePlaylistRow,
  type LoungeSharerRow,
} from './lounge-repo';
