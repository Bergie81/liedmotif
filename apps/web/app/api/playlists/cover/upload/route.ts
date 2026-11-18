// `POST /api/playlists/cover/upload` — set a custom Playlist cover by upload
// (upload or generation, same surface; the derived mosaic is always
// the fallback). The raw upload is never stored: re-encoded to a square,
// metadata-free WebP, then registered + pointed at in ONE repo transaction
// (`setUploadedPlaylistCover`) — which also retires a replaced uploaded cover.
// Unlike a Session cover, a Playlist upload applies immediately: this surface
// has no preview step. An upload takes one of the playlist's
// MAX_PLAYLIST_COVER_HISTORY slots, like a generated cover.

import { NextResponse } from 'next/server';
import { setUploadedPlaylistCover, type SetUploadedPlaylistCoverResult } from '@liedmotif/db';
import { MAX_PLAYLIST_COVER_HISTORY, uuidSchema } from '@liedmotif/shared';
import { apiError, apiOk, requireOwnerId } from '@/lib/api-response';
import { processCoverUpload, storeUploadedCover } from '@/lib/cover-upload-image';
import { getDb } from '@/lib/db';
import { readImageUpload, readUploadForm, withImageUploadAdmission } from '@/lib/image-upload';
import type { RecordStoredBytes } from '@/lib/storage-quota';

export const dynamic = 'force-dynamic';

const PLAYLIST_FULL_MESSAGE = `This Playlist already keeps ${MAX_PLAYLIST_COVER_HISTORY} covers. Delete a previous cover to upload another one.`;

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return withImageUploadAdmission(ownerUserId, (recordStored) =>
    storePlaylistCover(request, ownerUserId, recordStored),
  );
}

async function storePlaylistCover(
  request: Request,
  ownerUserId: string,
  recordStored: RecordStoredBytes,
): Promise<Response> {
  const form = await readUploadForm(request);
  if (form instanceof NextResponse) return form;
  // Ahead of the decode: a malformed id would otherwise reach the uuid-typed
  // query (a 500) only after the image was read and re-encoded for nothing.
  const playlistId = uuidSchema.safeParse(form.get('playlistId'));
  if (!playlistId.success) {
    return apiError('validation_error', 'A playlistId form field is required.');
  }
  const upload = await readImageUpload(form);
  if (upload instanceof NextResponse) return upload;

  const processed = await processCoverUpload(upload.bytes);
  if (!processed) return apiError('validation_error', 'The file could not be read as an image.');

  let outcome = 'not_found' as SetUploadedPlaylistCoverResult;
  const coverImageId = await storeUploadedCover({
    ownerUserId,
    processed,
    recordStored,
    register: async (cover) => {
      outcome = await setUploadedPlaylistCover(getDb(), {
        ownerUserId,
        playlistId: playlistId.data,
        maxHistory: MAX_PLAYLIST_COVER_HISTORY,
        ...cover,
      });
      return outcome === 'applied';
    },
  });
  if (coverImageId) return apiOk({ coverImageId });
  return outcome === 'history_full'
    ? apiError('limit_reached', PLAYLIST_FULL_MESSAGE)
    : apiError('not_found', 'Playlist not found.');
}
