'use client';

// Where the Player reads what it shows of a Track besides its audio: the cover
// image, the lock-screen artwork, the lyrics and the Track Data. The app reads
// them from the server; the Offline Library provides the device's offline
// store instead, for everything under it, so the Player's surfaces stay the
// same and make no request. (Audio is chosen at the decks instead: each Track
// carries its own pinned URLs, and one the device stores plays from the
// device first — `DeckSources`.)

import { createContext, useContext, type ReactNode } from 'react';
import type { TrackDetails, TrackLyrics } from '@liedmotif/shared';
import { getTrackDetails, getTrackLyrics, type ApiResult } from '@/lib/http/api-client';
import { coverArtSrc } from './player-presentation';

export interface TrackMedia {
  /** The image a cover shows, or null where there is none to show (the
   *  surface's own fallback art stands in). */
  coverSrc(coverImageId: string | null, size?: 'full' | 'thumb'): string | null;
  /** The lock-screen artwork for a cover. */
  artwork(coverImageId: string | null): MediaImage[];
  lyrics(trackId: string): Promise<ApiResult<TrackLyrics>>;
  details(trackId: string): Promise<ApiResult<TrackDetails>>;
}

/** App-routed only, never a provider URL; no `type` on a cover,
 *  whose route serves the stored format. */
export const SERVER_TRACK_MEDIA: TrackMedia = {
  coverSrc: coverArtSrc,
  artwork: (coverImageId) => [
    coverImageId
      ? { src: `/api/covers/${coverImageId}`, sizes: '512x512' }
      : { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml' },
  ],
  lyrics: (trackId) => getTrackLyrics(trackId),
  details: (trackId) => getTrackDetails(trackId),
};

const TrackMediaContext = createContext<TrackMedia>(SERVER_TRACK_MEDIA);

export function TrackMediaProvider({
  media,
  children,
}: {
  media: TrackMedia;
  children: ReactNode;
}) {
  return <TrackMediaContext.Provider value={media}>{children}</TrackMediaContext.Provider>;
}

export function useTrackMedia(): TrackMedia {
  return useContext(TrackMediaContext);
}
