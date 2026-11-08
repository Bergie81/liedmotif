// `GET /api/tracks/[trackId]/details` → one readable track's descriptive data
// (the player's Track Data sheet). Scoped owner-or-Lounge-audible in the repo
// query — a Visitor reads a shared track's full Track Data; a
// malformed, unknown, or unreadable id is the same 404. This is the ONE place
// the style/expanded prompt reaches the client (the queue payload stays slim);
// nothing vendor-secret is ever selected — see `getReadableTrackDetails`.

import { NextResponse } from 'next/server';
import { getReadableTrackDetails } from '@liedmotif/db';
import { uuidSchema, type TrackDetails } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;

  const { trackId } = await params;
  if (!uuidSchema.safeParse(trackId).success) return apiError('not_found', 'Track not found.');

  const details = await getReadableTrackDetails(getDb(), { viewerUserId, trackId });
  if (!details) return apiError('not_found', 'Track not found.');

  return apiOk<TrackDetails>({
    title: details.title,
    sessionTitle: details.sessionTitle,
    artistName: details.artistName,
    createdAt: details.createdAt.toISOString(),
    durationSeconds: details.durationSeconds,
    userPrompt: details.userPrompt,
    stylePrompt: details.stylePrompt,
    expandedPrompt: details.expandedPrompt,
    genreTags: details.genreTags,
    activity: details.activity,
    mood: details.mood,
    energy: details.energy,
    vocalMode: details.vocalMode,
    language: details.language,
    bpm: details.bpmEstimate != null ? Math.round(details.bpmEstimate) : null,
    providerKey: details.providerKey,
    providerModel: details.providerModel,
    licenseNote: details.licenseNote,
  });
}
