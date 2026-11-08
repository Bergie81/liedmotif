// Search domain barrel: the ranked, capped retrieval behind /search. The match
// vocabulary (one definition of what a query "matches", shared with the
// Library's boolean filters) stays package-internal — it builds SQL, so its
// callers are repos, never app code.
export {
  searchPlaylists,
  searchSessions,
  searchTracks,
  type SearchArgs,
  type SearchGroup,
  type SearchMatch,
  type SearchPlaylistHit,
  type SearchSessionHit,
  type SearchSort,
  type SearchTrackHit,
} from './search-repo';
