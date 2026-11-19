export interface TrackRetentionFlags {
  savedAt: string | null;
  favoritedAt: string | null;
}

export function optimisticFavoriteFlags(
  current: TrackRetentionFlags,
  favorited: boolean,
  timestamp: string,
): TrackRetentionFlags {
  return favorited
    ? { savedAt: current.savedAt ?? timestamp, favoritedAt: timestamp }
    : { savedAt: current.savedAt, favoritedAt: null };
}

export function settleTrackFlags(
  previous: TrackRetentionFlags,
  serverFlags: TrackRetentionFlags | null,
): TrackRetentionFlags {
  return serverFlags ?? previous;
}

/** What an Assistant write added to a Track's shelves. It only ever adds: it
 *  never unfavorites, unsaves, or takes a Track out of a Playlist. */
export interface RetentionAdded {
  favorited: boolean;
  curated: boolean;
}

/** The flags once `added` landed on top of `current`. A Favorite or any
 *  Playlist saves the Track; a time already set stays, as the server keeps the
 *  earliest membership. */
export function withRetentionAdded(
  current: TrackRetentionFlags,
  added: RetentionAdded,
  timestamp: string,
): TrackRetentionFlags {
  return {
    savedAt: current.savedAt ?? timestamp,
    favoritedAt: added.favorited ? (current.favoritedAt ?? timestamp) : current.favoritedAt,
  };
}
