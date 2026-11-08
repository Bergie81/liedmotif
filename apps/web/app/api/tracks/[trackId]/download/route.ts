// Owner-authorized single-track download (only bytes leave the
// server). Serves the local final as an attachment named
// `<title-slug>-<id8>.<ext>`, carrying the Session's tags as they are right now.
// Never falls back to the provider stream — that would export untagged,
// transient audio and can hold the request for minutes — so a track without a
// downloaded final is indistinguishable from a missing one (404, the same IDOR
// posture as the audio route).

import { NextResponse } from 'next/server';
import { getOwnedDownloadableTrack } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { contentTypeForKey } from '@liedmotif/storage';
import { requireOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { getStorageProvider } from '@/lib/providers';
import {
  createTrackDownloadDeps,
  openTrackDownload,
  planTrackDownloads,
  trackDownloadFileName,
} from '@/lib/track-downloads';
import { webStreamFromReadable } from '@/lib/web-stream';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ trackId: string }> },
): Promise<Response> {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const { trackId } = await params;
  if (!uuidSchema.safeParse(trackId).success) return notFound();
  const track = await getOwnedDownloadableTrack(getDb(), { ownerUserId, trackId });
  if (!track) return notFound();

  const deps = createTrackDownloadDeps(getDb(), getStorageProvider());
  // Row exists but the bytes are gone (e.g. tampered volume) → treat as absent.
  const [planned] = await planTrackDownloads(deps, [track]);
  if (!planned) return notFound();

  const body = await openTrackDownload(deps, planned);
  return new NextResponse(webStreamFromReadable(body.stream), {
    status: 200,
    headers: {
      'Content-Type': track.mimeType ?? contentTypeForKey(track.storageKey),
      'Content-Length': String(body.byteSize),
      'Content-Disposition': `attachment; filename="${trackDownloadFileName(track)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
