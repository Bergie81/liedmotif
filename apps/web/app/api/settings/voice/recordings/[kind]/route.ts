// `GET /api/settings/voice/recordings/[kind]` — stream the owner's stored
// recording for in-app preview. Owner-authorized; the client fetches to a blob
// URL, so no Range support is needed. Never cached across users (private).

import { NextResponse } from 'next/server';
import { getVoiceProfile, getVoiceRecording } from '@liedmotif/db';
import { VOICE_RECORDING_KINDS, type VoiceRecordingKindValue } from '@liedmotif/shared';
import { apiError, requireAdminOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { ownVoiceEnabled } from '@/lib/env';
import { privateBytesResponse } from '@/lib/private-bytes';
import { getStorageProvider } from '@/lib/providers';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!ownVoiceEnabled()) return apiError('not_found', 'Not found.');
  const { kind } = await params;
  if (!(VOICE_RECORDING_KINDS as readonly string[]).includes(kind)) return notFound();

  const db = getDb();
  const profile = await getVoiceProfile(db, ownerUserId);
  if (!profile) return notFound();
  const recording = await getVoiceRecording(db, {
    ownerUserId,
    voiceProfileId: profile.id,
    kind: kind as VoiceRecordingKindValue,
  });
  if (!recording) return notFound();

  let stream;
  try {
    stream = await getStorageProvider().readStream(recording.storageKey);
  } catch {
    // A concurrent re-record can delete the object between lookup and read.
    return notFound();
  }
  return privateBytesResponse({
    body: stream,
    contentType: recording.mimeType,
    byteSize: recording.byteSize,
    cache: 'no-store',
  });
}
