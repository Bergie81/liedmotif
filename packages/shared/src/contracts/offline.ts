// Offline playback contracts: the manifest a device diffs its Available-offline
// copy against. One manifest per marked collection; each entry is a Track the
// viewer may store, carrying what the device keeps besides the audio, so the
// device can list and play it without asking the server again. A standalone
// read, like getTrackDetails — not a registry contract.

import { z } from 'zod';
import { apiResponse, uuidSchema } from './common';
import { VOCAL_MODES } from './domain';

export const offlineManifestTrackSchema = z.strictObject({
  trackId: uuidSchema,
  /** The stored local final's recorded size; null on a row that never recorded one. */
  byteSize: z.number().int().nonnegative().nullable(),
  /** Opaque; changes whenever something the device keeps besides the audio
   *  (presentation, Track Data, lyrics, cover) would read differently. */
  version: z.string().min(1),
  title: z.string().nullable(),
  /** The Track's generated artist name — what the Player shows under the title. */
  artist: z.string().nullable(),
  originSessionTitle: z.string().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  /** The cover the Track shows (its Session's cover, else its own). */
  coverImageId: uuidSchema.nullable(),
  genreTags: z.array(z.string().min(1)),
  vocalMode: z.enum(VOCAL_MODES),
  hasLyrics: z.boolean(),
  /** Another owner's Track, held only while it stays Lounge-audible to the
   *  viewer: its offline copy expires without a recent sync. */
  fromLounge: z.boolean(),
});
export type OfflineManifestTrack = z.infer<typeof offlineManifestTrackSchema>;

/** One marked collection as the server holds it now, Tracks in play order. */
export const offlineManifestSchema = z.strictObject({
  name: z.string(),
  tracks: z.array(offlineManifestTrackSchema),
  /** The collection's Tracks the viewer can hear that `tracks` leaves out —
   *  stream-only, still landing, or past the export bound. While any remain, no
   *  device holds the whole collection. */
  leftOutTrackCount: z.number().int().nonnegative(),
});
export type OfflineManifest = z.infer<typeof offlineManifestSchema>;

export const getOfflineManifestResponseSchema = apiResponse(offlineManifestSchema);
export type GetOfflineManifestResponse = z.infer<typeof getOfflineManifestResponseSchema>;
