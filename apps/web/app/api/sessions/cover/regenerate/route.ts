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
  getUsageLimits,
  reserveSessionCoverRegeneration,
  setSessionCoverStyle,
  withOwnerCoverAdmissionLock,
} from '@liedmotif/db';
import { MAX_SESSION_COVER_HISTORY, regenerateSessionCoverRequestSchema } from '@liedmotif/shared';
import { storageKeys } from '@liedmotif/storage';
import { ACCOUNT_DISABLED_MESSAGE } from '@/lib/constants';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { COVER_LIMIT_REACHED_MESSAGE, refuseWhenCoverBudgetExhausted } from '@/lib/cover-budget';
import { enhanceCoverText } from '@/lib/cover-enhancement';
import { coverViewerRole } from '@/lib/cover-regeneration';
import { coverSetupMessage } from '@/lib/cover-setup-copy';
import {
  generatedCoverModel,
  generatedCoverProviderConfigured,
  resolveCoverArtChoice,
} from '@/lib/covers';
import { getDb } from '@/lib/db';
import { enqueueRegenerateSessionCover } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

const SESSION_FULL_MESSAGE = `This Session already keeps ${MAX_SESSION_COVER_HISTORY} covers. Delete a previous cover to generate a new one.`;

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

  // Fast-fail gates the worker would refuse anyway — nothing is reserved for a
  // request that cannot be admitted. The worker's admission stays authoritative.
  if (!(await generatedCoverProviderConfigured())) {
    return apiError(
      'conflict',
      coverSetupMessage('provider_unconfigured', await coverViewerRole(db, ownerUserId)),
    );
  }
  const limits = await getUsageLimits(db);
  if (!limits.tailoredCoverArtEnabled) {
    return apiError(
      'conflict',
      coverSetupMessage('generation_disabled', await coverViewerRole(db, ownerUserId)),
    );
  }

  // A live attempt short-circuits before any LLM work — the admission lock
  // below re-checks, so this is purely a wasted-call guard, not the gate.
  const alreadyLive = await getLiveSessionCoverGeneration(db, {
    ownerUserId,
    activitySessionId: session.id,
  });
  if (alreadyLive) {
    return apiOk({ outcome: 'pending' as const, coverGenerationId: alreadyLive.id });
  }
  // Same wasted-call guard for the per-session cover cap; the lock re-checks.
  const kept = await countSessionCoverHistory(db, { ownerUserId, activitySessionId: session.id });
  if (kept >= MAX_SESSION_COVER_HISTORY) {
    return apiError('limit_reached', SESSION_FULL_MESSAGE);
  }

  // `random` resolves to a concrete persisted style at request time, exactly
  // like Session creation; the resolved pick becomes the session's style.
  const styleChange = parsed.coverStyle ? await resolveCoverArtChoice(db, parsed.coverStyle) : null;
  const guidance = parsed.guidance?.trim() || undefined;

  // Enhancement happens HERE, before the attempt's inputs are frozen — the
  // cover generator stays LLM-free. The call never fails the
  // action; without an LLM the path is byte-for-byte the deterministic one.
  let effectiveGuidance: string | undefined;
  let enhancementApplied: boolean | undefined;
  if (guidance) {
    // The paid enhancement is the only spend before the lock, so guard it with a
    // lock-free budget precheck: a budget-exhausted tap must not burn an
    // unmetered LLM call. The admission below stays authoritative.
    const budgetRefusal = await refuseWhenCoverBudgetExhausted({
      ownerUserId,
      instanceLimits: limits,
    });
    if (budgetRefusal) return budgetRefusal;
    const enhancement = await enhanceCoverText(db, {
      text: guidance,
      override: parsed.enhance,
      context: {
        sessionName: session.title,
        style: styleChange?.coverStyle ?? session.coverStyle,
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
  if (reservation.outcome === 'session_full') {
    return apiError('limit_reached', SESSION_FULL_MESSAGE);
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
