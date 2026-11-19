// Owner-authorized Session zip download (only bytes leave the
// server). Streams `<sessionId>.zip` containing the session's downloadable
// tracks — local finals in play order up to the export ceiling
// (`MAX_EXPORT_TRACKS`), every entry carrying the Session's tags as they are
// right now. An empty/foreign/unknown session is a uniform 404; the
// zero-track case is what the UI's trackCount-gated menu rows avoid triggering.

import { NextResponse } from 'next/server';
import { getOwnedSessionDownloadTracks } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { getStorageProvider } from '@/lib/providers/providers';
import { createTrackDownloadDeps } from '@/lib/downloads/track-downloads';
import { tracksZipResponse } from '@/lib/downloads/zip-download';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const { sessionId } = await params;
  if (!uuidSchema.safeParse(sessionId).success) return notFound();
  const tracks = await getOwnedSessionDownloadTracks(getDb(), { ownerUserId, sessionId });
  if (tracks.length === 0) return notFound();

  const deps = createTrackDownloadDeps(getDb(), getStorageProvider());
  return (await tracksZipResponse(deps, tracks, `${sessionId}.zip`)) ?? notFound();
}
