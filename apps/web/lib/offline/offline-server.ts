// The server reads an offline sync makes, over the app's own routes: the
// manifest route, the audio route's pinned local final (the exact stored bytes,
// never the provider stream), the cover route, Track Data, and the lyrics read
// in its cached-only form. Bytes skip the HTTP cache — the offline store is
// their one copy on the device.

import {
  getOfflineManifestResponseSchema,
  getTrackDetailsResponseSchema,
  getTrackLyricsResponseSchema,
} from '@liedmotif/shared';
import type { OfflineMarkKind } from './offline-store';
import type { OfflineServer } from './offline-sync';

const MANIFEST_PATHS: Record<OfflineMarkKind, string> = {
  playlist: '/api/offline/playlists',
  session: '/api/offline/sessions',
};

interface Envelope<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: { ok: true; data: T } | { ok: false } } | { success: false };
}

async function answered(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Offline sync read failed (${response.status}).`);
  return response;
}

async function decoded<T>(response: Response, schema: Envelope<T>): Promise<T> {
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.ok) throw new Error('Unexpected offline sync answer.');
  return parsed.data.data;
}

export const offlineServer: OfflineServer = {
  async manifest(mark, signal) {
    const url = `${MANIFEST_PATHS[mark.kind]}/${encodeURIComponent(mark.id)}`;
    const response = await fetch(url, { signal, cache: 'no-store' });
    if (response.status === 404) return 'gone';
    if (!response.ok) throw new Error(`Offline manifest read failed (${response.status}).`);
    return decoded(response, getOfflineManifestResponseSchema);
  },
  audio: async (trackId, signal) =>
    (await answered(`/api/audio/${encodeURIComponent(trackId)}?asset=final`, signal)).blob(),
  cover: async (coverImageId, signal) =>
    (await answered(`/api/covers/${encodeURIComponent(coverImageId)}`, signal)).blob(),
  details: async (trackId, signal) =>
    decoded(
      await answered(`/api/tracks/${encodeURIComponent(trackId)}/details`, signal),
      getTrackDetailsResponseSchema,
    ),
  lyrics: async (trackId, signal) =>
    decoded(
      await answered(`/api/tracks/${encodeURIComponent(trackId)}/lyrics?cached=1`, signal),
      getTrackLyricsResponseSchema,
    ),
};
