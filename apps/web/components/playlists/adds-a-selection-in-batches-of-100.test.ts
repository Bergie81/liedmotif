// One add request takes at most 100 Tracks, so a larger selection goes in
// consecutive batches. The fake server below keeps the Playlist the way the
// real add does: idempotent per Track, appended in request order.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { addTracksInBatches } from './add-tracks-in-batches';

const server = vi.hoisted(() => ({
  playlist: [] as string[],
  requests: [] as string[][],
  failOnRequest: null as number | null,
}));

vi.mock('@/lib/api-client', () => ({
  addPlaylistTracks: async (playlistId: string, trackIds: string[]) => {
    server.requests.push(trackIds);
    if (server.requests.length === server.failOnRequest) {
      return {
        ok: false as const,
        error: { code: 'internal_error', message: 'Offline.', retryable: true },
      };
    }
    const added = trackIds.filter((id) => !server.playlist.includes(id));
    server.playlist.push(...added);
    return { ok: true as const, data: { playlistId, added, refused: [] } };
  },
}));

afterEach(() => {
  server.playlist = [];
  server.requests = [];
  server.failOnRequest = null;
});

const ids = (count: number) => Array.from({ length: count }, (_, i) => `track-${i + 1}`);

describe('adding a selection in batches of 100', () => {
  it('sends 250 Tracks as requests of 100, 100 and 50 in the picked order', async () => {
    const picked = ids(250);

    const result = await addTracksInBatches('beach-id', picked);

    expect(server.requests.map((request) => request.length)).toEqual([100, 100, 50]);
    expect(server.requests.flat()).toEqual(picked);
    expect(result).toEqual({
      ok: true,
      data: { playlistId: 'beach-id', added: picked, refused: [] },
    });
    expect(server.playlist).toEqual(picked);
  });

  it('stops at a failed later batch and says earlier batches landed', async () => {
    server.failOnRequest = 2;

    const result = await addTracksInBatches('beach-id', ids(250));

    expect(server.requests).toHaveLength(2);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ message: 'Offline.' }),
      partial: true,
    });
    expect(server.playlist).toEqual(ids(100));
  });

  it('reports a failed first batch as nothing added', async () => {
    server.failOnRequest = 1;

    const result = await addTracksInBatches('beach-id', ids(250));

    expect(server.requests).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ message: 'Offline.' }),
      partial: false,
    });
    expect(server.playlist).toEqual([]);
  });

  it('adds only what is missing on a retry after a failed batch', async () => {
    const picked = ids(250);
    server.failOnRequest = 2;
    await addTracksInBatches('beach-id', picked);

    server.failOnRequest = null;
    const retry = await addTracksInBatches('beach-id', picked);

    expect(retry.ok && retry.data.added).toEqual(picked.slice(100));
    expect(server.playlist).toEqual(picked);
  });
});
