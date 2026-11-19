import { addPlaylistTracks, type AddPlaylistTracksData, type ApiResult } from '@/lib/api-client';

/** The most Track ids one `addPlaylistTracks` request takes. */
const ADD_BATCH = 100;

type AddFailure = Extract<ApiResult<AddPlaylistTracksData>, { ok: false }>;

export type BatchedAddResult =
  | { ok: true; data: AddPlaylistTracksData }
  /** `partial`: an earlier batch landed, so the Playlist already changed. */
  | (AddFailure & { partial: boolean });

/**
 * Add any number of Tracks to a Playlist in consecutive requests of at most
 * ADD_BATCH, stopping at the first failure. Adds are idempotent and append in
 * request order, so the batches keep the picked order and resending the whole
 * selection after a failure adds only what is still missing.
 */
export async function addTracksInBatches(
  playlistId: string,
  trackIds: string[],
): Promise<BatchedAddResult> {
  const data: AddPlaylistTracksData = { playlistId, added: [], refused: [] };
  for (let start = 0; start < trackIds.length; start += ADD_BATCH) {
    const result = await addPlaylistTracks(playlistId, trackIds.slice(start, start + ADD_BATCH));
    if (!result.ok) return { ...result, partial: start > 0 };
    data.added.push(...result.data.added);
    data.refused.push(...result.data.refused);
  }
  return { ok: true, data };
}
