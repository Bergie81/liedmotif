// The ONE spelling of "this track has a servable, downloaded local final" —
// the predicate that decides whether a track's bytes can be served or zipped
// by the download routes (stream-only tracks have bytes only behind the
// provider URL and are never exported) — plus the row shape those
// routes consume.

import { and, eq, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { tracks, trackAudioAssets } from '../schema';

/** Conditions selecting a track's servable `local_original` asset row. */
export function servableLocalFinalConditions(): SQL {
  return and(
    eq(trackAudioAssets.assetType, 'local_original'),
    eq(trackAudioAssets.isPlayable, true),
    isNotNull(trackAudioAssets.storageKey),
    ne(trackAudioAssets.storageKey, ''),
  )!;
}

/**
 * The most Tracks one export read materializes, and so the most entries a zip
 * carries. Every row costs the download plan a storage stat and a tag-context row
 * before a single byte streams, so an unbounded selection would let one request
 * fan a whole library out over the storage backend. 500 is chosen the way the
 * playlist order write chose its own: past it a collection is beyond
 * hand-management, and 500 MP3s is already a multi-gigabyte download. A longer
 * selection is delivered in order up to here; going further needs the zip route
 * to plan in batches rather than a bigger number.
 */
export const MAX_EXPORT_TRACKS = 500;

/** One zippable track: current title (entry names follow renames) + its stored bytes. */
export interface DownloadableTrack {
  trackId: string;
  title: string | null;
  storageKey: string;
  mimeType: string | null;
  byteSize: number | null;
}

/** The download selections' shared projection over `tracks` inner-joined to the
 *  servable local-final asset. `storageKey` is typed non-null because the
 *  `servableLocalFinalConditions` join guarantees it. */
export function downloadableTrackColumns() {
  return {
    trackId: tracks.id,
    title: tracks.title,
    storageKey: sql<string>`${trackAudioAssets.storageKey}`,
    mimeType: trackAudioAssets.mimeType,
    byteSize: trackAudioAssets.byteSize,
  } as const;
}
