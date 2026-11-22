// `POST /api/sessions`  → startSession (free text or structured controls)
// `GET  /api/sessions`  → listSessions (My Sessions: resumable Stopped sessions,
//                         optionally split into the Pinned section)
//
// Start Session derives the session's ONE Style Snapshot (template for structured
// controls; text LLM for free text when configured, deterministic prompt
// passthrough otherwise), gates creation on cost-limit headroom
// (below the threshold NO session row is created), then creates an active
// session that supersedes the prior active one (`endReason='superseded'`). Provider
// keys never reach the client; all provider work is server-side.

import { NextResponse } from 'next/server';
import { createSession, getCoverArtSettings } from '@liedmotif/db';
import {
  listSessionsRequestSchema,
  startSessionRequestSchema,
  targetDurationMinutesSchema,
} from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import {
  apiError,
  apiOk,
  apiRateLimited,
  parseJsonBody,
  requireOwnerId,
  validateInput,
  validateKeysetCursor,
} from '@/lib/http/api-response';
import { sessionCreateLimiter } from '@/lib/http/request-limits';
import {
  deriveNamedSnapshotForIntent,
  loadSessionList,
  newSessionTargetMinutes,
  sessionCreationRefusal,
  toSessionSummary,
} from '@/lib/sessions/sessions';
import { getLlmProvider } from '@/lib/providers/providers';
import {
  initialSessionCoverId,
  launchSessionCreationKickoffs,
  resolveCoverArtChoiceFrom,
} from '@/lib/covers/covers';
import { intentRequestsOwnVoice, ownVoiceBlockedMessage } from '@/lib/voice/voice';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    startSessionRequestSchema,
    'Invalid Start Session request.',
  );
  if (parsed instanceof NextResponse) return parsed;
  const { input, targetDurationMinutes, coverStyle, skipProfile } = parsed;

  const db = getDb();

  // Gate FIRST so a blocked request creates no row and (for free text) spends no
  // LLM. Both gates are free reads with no data dependency, so they run together;
  // the creation refusal answers first when both would block.
  const [refusal, voiceBlocked] = await Promise.all([
    sessionCreationRefusal(db, ownerUserId),
    // "Use my voice" is honored or rejected — never silently downgraded to
    // generic vocals.
    intentRequestsOwnVoice(input) ? ownVoiceBlockedMessage(db, ownerUserId) : null,
  ]);
  if (refusal) return apiError(refusal.code, refusal.message);
  if (voiceBlocked) return apiError('validation_error', voiceBlocked);

  // The last gate, and the only one that meters the text LLM: the budget windows
  // count music tasks, so nothing else bounds the derivation below. Taken after
  // the refusals above so a request that spends no LLM consumes no budget.
  const creates = sessionCreateLimiter.check(ownerUserId);
  if (!creates.allowed) return apiRateLimited(creates.retryAfterMs);

  // The LLM-bearing derivation overlaps the Snapshot-independent reads. No paid
  // call moves ahead of the gates.
  const [derived, coverArtSettings, coverImageId] = await Promise.all([
    // One step: snapshot derivation + creative naming, with the owner's listener
    // profile (Settings → Profile) applied inside — the route never handles it.
    // `skipProfile` starts the session without that profile (the home toggle).
    deriveNamedSnapshotForIntent(db, ownerUserId, input, { skipProfile }),
    getCoverArtSettings(db, ownerUserId),
    initialSessionCoverId(db),
  ]);
  if (!derived.ok) {
    return apiError('provider_error', derived.message, { retryable: true });
  }
  const { snapshot, title, userPrompt, coverConcept, autoCoverStyle } = derived;
  const resolvedDurationMinutes = await newSessionTargetMinutes(
    db,
    ownerUserId,
    targetDurationMinutes,
    derived.requestedDurationMinutes,
  );
  if (
    resolvedDurationMinutes != null &&
    !targetDurationMinutesSchema.safeParse(resolvedDurationMinutes).success
  ) {
    return apiError(
      'validation_error',
      'Session duration must be a whole number from 1 to 600 minutes.',
    );
  }

  // Cover-source resolution: an explicit request wins; otherwise the no-AI paths
  // — hand-tuned (controls) sessions and no-LLM prompt passthrough — default to
  // standard covers, keeping the image model out too, and
  // LLM-backed prompt sessions follow the owner's saved default. Short-circuit
  // order keeps the LLM resolution off the controls path entirely.
  const useStandardCover =
    parsed.useStandardCover ??
    (input.mode === 'controls' ||
      (await getLlmProvider()) === null ||
      coverArtSettings.useStandardCoverArt);
  // The listener cancelled while the vibe was being set (or chose other music,
  // which cancels too): creating now would buy music nobody asked for and
  // supersede the Session they are listening to.
  if (request.signal.aborted) {
    return apiError('conflict', 'The session start was cancelled.');
  }
  const { session: created, supersededSessionId } = await createSession(db, {
    ownerUserId,
    snapshot,
    sessionMode: 'keep_going',
    title,
    coverConcept,
    autoCoverStyle,
    userPrompt,
    structuredControls: input.mode === 'controls' ? input.controls : null,
    ...(skipProfile ? { skipProfile } : {}),
    includesListener: derived.includesListener,
    useStandardCover,
    targetDurationMinutes: resolvedDurationMinutes,
    coverImageId,
    // Cover-only preferences for the async generated cover (never the music
    // snapshot): the art-direction lane and — when the user picked `custom` —
    // the saved Custom style definition (Settings → Cover Arts) as the RAW
    // hint. The cover job normalizes the hint exactly once (optional LLM,
    // deterministic fallback) AFTER its own preflight — creation stays
    // deterministic and never spends or waits on a text-LLM call for a cover
    // that may not run.
    ...resolveCoverArtChoiceFrom(coverArtSettings.customStyleDefinition, coverStyle),
  });
  await launchSessionCreationKickoffs(db, created);

  return apiOk({ session: toSessionSummary(created), supersededSessionId });
}

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    listSessionsRequestSchema,
    {
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      includeActive: url.searchParams.get('includeActive') ?? undefined,
      includePinned: url.searchParams.get('includePinned') ?? undefined,
    },
    'Invalid sessions request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const cursor = validateKeysetCursor(parsed.cursor, 'Invalid sessions cursor.');
  if (cursor instanceof NextResponse) return cursor;

  return apiOk(
    await loadSessionList(getDb(), ownerUserId, {
      cursor,
      limit: parsed.limit,
      includeActive: parsed.includeActive,
      includePinned: parsed.includePinned,
    }),
  );
}
