// GET /api/playlists/cover/status — the playlist cover modal's bootstrap and
// poll: the playlist's custom cover (null = the derived mosaic), whether a
// generation attempt is in flight, the latest regeneration outcome
// (sanitized), the shared cover budget, and the re-selectable history
// (generated attempts plus uploaded covers). Advisory only — the worker's
// admission check stays authoritative.

import { NextResponse } from 'next/server';
import {
  getLatestPlaylistCoverRegeneration,
  getLivePlaylistCoverGeneration,
  getPlaylistCoverSubject,
  listPlaylistCoverHistory,
  listUploadedPlaylistCovers,
} from '@liedmotif/db';
import { playlistCoverStatusRequestSchema } from '@liedmotif/shared';
import { apiError, apiOk, requireOwnerId, validateInput } from '@/lib/http/api-response';
import { toCoverHistory } from '@/lib/covers/cover-history';
import { loadCoverStatusReads } from '@/lib/covers/cover-status';
import { coverViewerRole, toSessionCoverAttempt } from '@/lib/covers/cover-regeneration';
import { generatedCoverProviderConfigured } from '@/lib/covers/covers';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const url = new URL(request.url);
  const parsed = validateInput(
    playlistCoverStatusRequestSchema,
    { playlistId: url.searchParams.get('playlistId') ?? undefined },
    'Invalid cover status request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const playlist = await getPlaylistCoverSubject(db, {
    ownerUserId,
    playlistId: parsed.playlistId,
  });
  if (!playlist) return apiError('not_found', 'Playlist not found.');

  const subject = { ownerUserId, playlistId: playlist.id };
  const {
    limits,
    live,
    latestRegeneration,
    usageView,
    peopleReferencesAvailable,
    generated,
    uploaded,
  } = await loadCoverStatusReads(db, ownerUserId, {
    live: () => getLivePlaylistCoverGeneration(db, subject),
    latestRegeneration: () => getLatestPlaylistCoverRegeneration(db, subject),
    generatedHistory: () => listPlaylistCoverHistory(db, subject),
    uploadedHistory: () => listUploadedPlaylistCovers(db, subject),
  });
  const { usage, remaining } = usageView;
  const history = toCoverHistory({
    generated,
    uploaded,
    currentCoverImageId: playlist.coverImageId,
  });
  return apiOk({
    coverImageId: playlist.coverImageId,
    generating: live !== null,
    latestRegeneration: latestRegeneration
      ? toSessionCoverAttempt(latestRegeneration, await coverViewerRole(db, ownerUserId))
      : null,
    usage: {
      usedDay: usage.usedDay,
      limitDay: usage.limitDay,
      usedMonth: usage.usedMonth,
      limitMonth: usage.limitMonth,
      remaining,
      oneTime: usage.oneTime,
      enabled: limits.tailoredCoverArtEnabled,
      providerConfigured: await generatedCoverProviderConfigured(),
      // Playlist covers are prompt-driven only — the music-task-driven Suno
      // source can never serve them.
      sunoFallbackActive: false,
    },
    history,
    peopleReferencesAvailable,
  });
}
