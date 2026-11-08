// Owner-authorized Playlist zip download (only bytes leave the
// server). Streams `<name-slug>-<id8>.zip` — the deterministic titled segment,
// hyphen-slugged, never a per-download random, so a re-download keeps a stable
// name — with the playlist's downloadable members in position order, up to the
// export ceiling (`MAX_EXPORT_TRACKS`). Each entry carries its own owning
// Session's current tags. Empty/foreign/unknown playlists are a uniform 404;
// Favorites downloads like any other playlist.

import { NextResponse } from 'next/server';
import { getOwnedPlaylistDownloadTracks } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { titledSegment } from '@liedmotif/storage';
import { requireOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { getStorageProvider } from '@/lib/providers';
import { createTrackDownloadDeps } from '@/lib/track-downloads';
import { tracksZipResponse } from '@/lib/zip-download';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ playlistId: string }> },
): Promise<Response> {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const { playlistId } = await params;
  if (!uuidSchema.safeParse(playlistId).success) return notFound();
  const result = await getOwnedPlaylistDownloadTracks(getDb(), { ownerUserId, playlistId });
  if (!result || result.tracks.length === 0) return notFound();

  const deps = createTrackDownloadDeps(getDb(), getStorageProvider());
  const zipName = titledSegment(result.playlist.name, 'playlist', result.playlist.id);
  return (await tracksZipResponse(deps, result.tracks, `${zipName}.zip`)) ?? notFound();
}
