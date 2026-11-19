// POST /api/sessions/cover/status — the regenerate modal's bootstrap and poll:
// the session's current cover, whether any generation attempt is in flight,
// and the latest user-regeneration outcome (sanitized). Advisory only — the
// worker's admission check stays authoritative.

import { NextResponse } from 'next/server';
import {
  getLatestSessionCoverRegeneration,
  getLiveSessionCoverGeneration,
  getSessionById,
  listSessionCoverHistory,
  listUploadedSessionCovers,
} from '@liedmotif/db';
import { sessionCoverStatusRequestSchema } from '@liedmotif/shared';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';
import { toCoverHistory } from '@/lib/covers/cover-history';
import { loadCoverStatusReads } from '@/lib/covers/cover-status';
import { coverViewerRole, toSessionCoverAttempt } from '@/lib/covers/cover-regeneration';
import { coverSource } from '@/lib/covers/cover-source';
import { generatedCoverProviderConfigured, sunoCoverFallbackConfigured } from '@/lib/covers/covers';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const parsed = await parseJsonBody(
    request,
    sessionCoverStatusRequestSchema,
    'Invalid cover status request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const session = await getSessionById(db, { ownerUserId, sessionId: parsed.activitySessionId });
  if (!session) return apiError('not_found', 'Session not found.');

  const subject = { ownerUserId, activitySessionId: session.id };
  const { limits, live, latestRegeneration, usageView, enhancement, generated, uploaded } =
    await loadCoverStatusReads(db, ownerUserId, {
      live: () => getLiveSessionCoverGeneration(db, subject),
      latestRegeneration: () => getLatestSessionCoverRegeneration(db, subject),
      generatedHistory: () => listSessionCoverHistory(db, subject),
      uploadedHistory: () => listUploadedSessionCovers(db, subject),
    });
  const { usage, remaining } = usageView;
  const history = toCoverHistory({
    generated,
    uploaded,
    currentCoverImageId: session.coverImageId,
  });
  const providerConfigured = await generatedCoverProviderConfigured();
  const activeCoverSource = coverSource({
    imageProviderConfigured: providerConfigured,
    tailoredCoverArtEnabled: limits.tailoredCoverArtEnabled,
    musicProviderCoverConfigured: await sunoCoverFallbackConfigured(),
  });
  return apiOk({
    coverImageId: session.coverImageId,
    coverStyle: session.coverStyle,
    sessionPrompt: session.userPrompt,
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
      providerConfigured,
      sunoFallbackActive: activeCoverSource === 'music-provider',
    },
    history,
    promptEnhancement: {
      llmConfigured: enhancement.llm !== null,
      active: enhancement.active,
    },
  });
}
