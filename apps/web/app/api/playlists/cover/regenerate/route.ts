// POST /api/playlists/cover/regenerate — reserve one user-triggered Playlist
// cover generation attempt and enqueue the worker job under a per-attempt key
// (the same machinery as Session Covers). The worker owns
// authoritative admission (limits, provider, planning); a live attempt is
// returned as `pending` so a double-tap can never double-spend. Unlike a
// Session, a Playlist persists no style — the resolved pick is frozen into the
// attempt itself.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  coverAdmissionDecision,
  getLivePlaylistCoverGeneration,
  getPlaylistCoverSubject,
  listPlaylistCoverHistory,
  reservePlaylistCoverRegeneration,
  withOwnerCoverAdmissionLock,
} from '@liedmotif/db';
import {
  MAX_PLAYLIST_COVER_HISTORY,
  regeneratePlaylistCoverRequestSchema,
} from '@liedmotif/shared';
import { storageKeys } from '@liedmotif/storage';
import { ACCOUNT_DISABLED_MESSAGE } from '@/lib/constants';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import {
  coverAttemptGate,
  coverGateRefusalResponse,
  PLAYLIST_COVERS_FULL_MESSAGE,
} from '@/lib/cover-attempt-gate';
import { COVER_LIMIT_REACHED_MESSAGE } from '@/lib/cover-budget';
import { enhanceCoverText } from '@/lib/cover-enhancement';
import { generatedCoverModel, resolveCoverArtChoice } from '@/lib/covers';
import { getDb } from '@/lib/db';
import { enqueueRegeneratePlaylistCover } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    regeneratePlaylistCoverRequestSchema,
    'Invalid cover regeneration request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const playlist = await getPlaylistCoverSubject(db, {
    ownerUserId,
    playlistId: parsed.playlistId,
  });
  if (!playlist) return apiError('not_found', 'Playlist not found.');

  // Fast-fail before anything is reserved or spent; the admission below re-checks
  // under the lock and stays the authority.
  const gate = await coverAttemptGate(db, {
    ownerUserId,
    subject: { kind: 'playlist', id: playlist.id },
  });
  if (gate.outcome === 'refused') return coverGateRefusalResponse(gate);
  if (gate.outcome === 'pending') {
    return apiOk({ outcome: 'pending' as const, coverGenerationId: gate.coverGenerationId });
  }
  const limits = gate.instanceLimits;

  // An omitted style is Random: a Playlist has no prompt for Auto to pick from
  // (ADR 0007). `random` resolves to a concrete style at request time and the
  // pick is frozen into the attempt (a Playlist persists no style of its own).
  const styleChoice = await resolveCoverArtChoice(db, ownerUserId, parsed.coverStyle ?? 'random');
  const coverStyle = styleChoice.coverStyle ?? 'auto';
  const guidance = parsed.guidance?.trim() || undefined;

  // Enhancement happens HERE, before the attempt's inputs are frozen — the
  // cover generator stays LLM-free. The call never fails the
  // action; without an LLM the path is byte-for-byte the deterministic one.
  let effectiveGuidance: string | undefined;
  let enhancementApplied: boolean | undefined;
  if (guidance) {
    const enhancement = await enhanceCoverText(db, {
      ownerUserId,
      text: guidance,
      override: parsed.enhance,
      context: {
        sessionName: playlist.name,
        style: coverStyle,
        mood: null,
        genres: playlist.genreTags,
        imageModel: await generatedCoverModel(),
      },
    });
    if (enhancement.llmConfigured) {
      enhancementApplied = enhancement.applied;
      if (enhancement.applied) effectiveGuidance = enhancement.text;
    }
  }

  const reservation = await withOwnerCoverAdmissionLock(db, ownerUserId, async (tx) => {
    const live = await getLivePlaylistCoverGeneration(tx, {
      ownerUserId,
      playlistId: playlist.id,
    });
    if (live) return { outcome: 'pending' as const, coverGenerationId: live.id };
    const keptInLock = await listPlaylistCoverHistory(tx, {
      ownerUserId,
      playlistId: playlist.id,
    });
    if (keptInLock.length >= MAX_PLAYLIST_COVER_HISTORY) {
      return { outcome: 'playlist_full' as const };
    }
    const admission = await coverAdmissionDecision(tx, {
      ownerUserId,
      instanceLimits: limits,
      now: new Date(),
    });
    if (!admission.admitted) {
      return admission.reason === 'account_disabled'
        ? { outcome: 'account_disabled' as const }
        : { outcome: 'limit_reached' as const };
    }
    const coverImageId = randomUUID();
    const reserved = await reservePlaylistCoverRegeneration(tx, {
      id: randomUUID(),
      ownerUserId,
      playlistId: playlist.id,
      coverImageId,
      storageKey: storageKeys.generatedPlaylistCover(
        ownerUserId,
        playlist.id,
        coverImageId,
        'webp',
      ),
      coverStyle,
      customDefinition: styleChoice.coverStyleHint ?? null,
      ...(guidance ? { userGuidance: guidance } : {}),
      ...(effectiveGuidance ? { effectiveGuidance } : {}),
      ...(enhancementApplied === undefined ? {} : { enhancementApplied }),
      // Frozen with the style pick: the worker's People selection, refusals
      // included, is decided by what THIS attempt asked for.
      ...(parsed.usePeopleReferences ? { usePeopleReferences: true } : {}),
    });
    return reserved ? { outcome: 'started' as const, coverGenerationId: reserved.id } : null;
  });
  if (!reservation) {
    return apiError('conflict', 'A cover generation is already in flight for this Playlist.');
  }
  if (reservation.outcome === 'playlist_full') {
    return apiError('limit_reached', PLAYLIST_COVERS_FULL_MESSAGE);
  }
  if (reservation.outcome === 'account_disabled') {
    return apiError('unauthorized', ACCOUNT_DISABLED_MESSAGE, { status: 403 });
  }
  if (reservation.outcome === 'limit_reached') {
    return apiError('limit_reached', COVER_LIMIT_REACHED_MESSAGE);
  }
  if (reservation.outcome === 'started') {
    await enqueueRegeneratePlaylistCover(db, {
      playlistId: playlist.id,
      ownerUserId,
      coverGenerationId: reservation.coverGenerationId,
    });
  }
  return apiOk(reservation);
}
