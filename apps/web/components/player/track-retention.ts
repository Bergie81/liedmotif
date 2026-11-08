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
