// POST /api/sessions/cover/regenerate — reserve one user-triggered Session
// Cover regeneration attempt and enqueue the worker job under a per-attempt
// key. The worker owns authoritative
// admission (limits, provider, planning); a live attempt is returned as
// `pending` so a double-tap can never double-spend.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  countSessionCoverHistory,
  coverAdmissionDecision,
  getLiveSessionCoverGeneration,
  getSessionById,
  lockSessionForCoverPlanning,
  reserveSessionCoverRegeneration,
  setSessionCoverStyle,
  withOwnerCoverAdmissionLock,
} from '@liedmotif/db';
import { MAX_SESSION_COVER_HISTORY, regenerateSessionCoverRequestSchema } from '@liedmotif/shared';
import { storageKeys } from '@liedmotif/storage';
import { ACCOUNT_DISABLED_MESSAGE } from '@/lib/constants';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import {
  coverAttemptGate,
  coverGateRefusalResponse,
  SESSION_COVERS_FULL_MESSAGE,
} from '@/lib/cover-attempt-gate';
import { COVER_LIMIT_REACHED_MESSAGE } from '@/lib/cover-budget';
import { enhanceCoverText } from '@/lib/cover-enhancement';
import { generatedCoverModel, resolveCoverArtChoice } from '@/lib/covers';
import { getDb } from '@/lib/db';
import { enqueueRegenerateSessionCover } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    regenerateSessionCoverRequestSchema,
    'Invalid cover regeneration request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const session = await getSessionById(db, { ownerUserId, sessionId: parsed.activitySessionId });
  // A Session whose delete is pending is gone to its owner: no new paid cover.
  if (!session || session.deleteRequestedAt) return apiError('not_found', 'Session not found.');

  // Fast-fail before anything is reserved or spent; the admission below re-checks
  // under the lock and stays the authority.
  const gate = await coverAttemptGate(db, {
    ownerUserId,
    subject: { kind: 'session', id: session.id },
  });
  if (gate.outcome === 'refused') return coverGateRefusalResponse(gate);
  if (gate.outcome === 'pending') {
    return apiOk({ outcome: 'pending' as const, coverGenerationId: gate.coverGenerationId });
  }
  const limits = gate.instanceLimits;

  // `random` resolves to a concrete persisted style at request time, exactly
  // like Session creation; the resolved pick becomes the session's style.
  const styleChange = parsed.coverStyle
    ? await resolveCoverArtChoice(db, ownerUserId, parsed.coverStyle)
    : null;
  const guidance = parsed.guidance?.trim() || undefined;

  // Enhancement happens HERE, before the attempt's inputs are frozen — the
  // cover generator stays LLM-free. The call never fails the
  // action; without an LLM the path is byte-for-byte the deterministic one.
  let effectiveGuidance: string | undefined;
  let enhancementApplied: boolean | undefined;
  if (guidance) {
    const style = styleChange?.coverStyle ?? session.coverStyle;
    const enhancement = await enhanceCoverText(db, {
      ownerUserId,
      text: guidance,
      override: parsed.enhance,
      context: {
        sessionName: session.title,
        // Auto plans in the preset the text LLM picked, so the rewrite writes for it.
        style: style === 'auto' ? (session.autoCoverStyle ?? 'auto') : style,
        mood: session.sessionStyleSnapshot?.mood ?? null,
        genres: session.sessionStyleSnapshot?.genreTags ?? [],
        imageModel: await generatedCoverModel(),
      },
    });
    if (enhancement.llmConfigured) {
      enhancementApplied = enhancement.applied;
      if (enhancement.applied) effectiveGuidance = enhancement.text;
    }
  }

  const reservation = await withOwnerCoverAdmissionLock(db, ownerUserId, async (tx) => {
    // The Session row is locked before the admission check takes a Member's Pool
    // lock, the order every Session-row path uses (a row lock after the Pool lock
    // deadlocks against a buffer tick). Session delete marks a pending delete
    // under this same admission lock, so the re-check here is the gate.
    const locked = await lockSessionForCoverPlanning(tx, { ownerUserId, sessionId: session.id });
    if (!locked || locked.deleteRequestedAt) return { outcome: 'not_found' as const };
    const live = await getLiveSessionCoverGeneration(tx, {
      ownerUserId,
      activitySessionId: session.id,
    });
    if (live) return { outcome: 'pending' as const, coverGenerationId: live.id };
    const keptInLock = await countSessionCoverHistory(tx, {
      ownerUserId,
      activitySessionId: session.id,
    });
    if (keptInLock >= MAX_SESSION_COVER_HISTORY) {
      return { outcome: 'session_full' as const };
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
    // An explicit pick always persists — re-picking Custom must refresh the
    // hint to the currently saved definition, never keep a stale one.
    if (styleChange?.coverStyle) {
      await setSessionCoverStyle(tx, {
        ownerUserId,
        sessionId: session.id,
        coverStyle: styleChange.coverStyle,
        coverStyleHint: styleChange.coverStyleHint ?? null,
      });
    }
    const coverImageId = randomUUID();
    const reserved = await reserveSessionCoverRegeneration(tx, {
      id: randomUUID(),
      ownerUserId,
      activitySessionId: session.id,
      coverImageId,
      storageKey: storageKeys.generatedCover(ownerUserId, session.id, coverImageId, 'webp'),
      ...(guidance ? { userGuidance: guidance } : {}),
      ...(effectiveGuidance ? { effectiveGuidance } : {}),
      ...(enhancementApplied === undefined ? {} : { enhancementApplied }),
    });
    return reserved ? { outcome: 'started' as const, coverGenerationId: reserved.id } : null;
  });
  if (!reservation) {
    return apiError('conflict', 'A cover generation is already in flight for this Session.');
  }
  if (reservation.outcome === 'not_found') return apiError('not_found', 'Session not found.');
  if (reservation.outcome === 'session_full') {
    return apiError('limit_reached', SESSION_COVERS_FULL_MESSAGE);
  }
  if (reservation.outcome === 'account_disabled') {
    return apiError('unauthorized', ACCOUNT_DISABLED_MESSAGE, { status: 403 });
  }
  if (reservation.outcome === 'limit_reached') {
    return apiError('limit_reached', COVER_LIMIT_REACHED_MESSAGE);
  }
  if (reservation.outcome === 'started') {
    await enqueueRegenerateSessionCover(db, {
      activitySessionId: session.id,
      ownerUserId,
      coverGenerationId: reservation.coverGenerationId,
    });
  }
  return apiOk(reservation);
}
