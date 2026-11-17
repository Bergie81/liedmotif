// `POST /api/sessions/more-like-this` → moreLikeThis.
//
// A track-seeded Start Session: creates a NEW session whose frozen Style Snapshot is
// reused from the seed track's originating session (no text-LLM call), superseding
// the active session (`endReason='superseded'`). Gated by the creation-time headroom
// check like Start Session: below the threshold NO session row is created.

import { NextResponse } from 'next/server';
import { createSession, getCoverArtSettings, getSeedSnapshot, getUsageLimits } from '@liedmotif/db';
import { moreLikeThisRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, apiRateLimited, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { sessionCreateLimiter } from '@/lib/request-limits';
import {
  deriveSnapshotForIntent,
  evaluateSessionHeadroom,
  headroomRefusalMessage,
  nameSeededSnapshot,
  startingSessionMode,
  stripPersonalIngredients,
  toSessionSummary,
  toStoredSnapshot,
} from '@/lib/sessions';
import {
  initialSessionCoverId,
  launchSessionCreationKickoffs,
  resolveCoverArtChoiceFrom,
} from '@/lib/covers';
import { honoredOwnVoice, ownVoiceBlockedMessage } from '@/lib/voice';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    moreLikeThisRequestSchema,
    'Invalid More Like This request.',
  );
  if (parsed instanceof NextResponse) return parsed;
  const { seedTrackIds, targetDurationMinutes } = parsed;

  const db = getDb();

  const usageLimits = await getUsageLimits(db);
  const headroom = await evaluateSessionHeadroom(db, ownerUserId, undefined, usageLimits);
  if (!headroom.allowed) {
    return apiError('session_headroom_blocked', await headroomRefusalMessage(db, headroom));
  }

  // Resolve the seed track's frozen Style Snapshot (the style that made it) in
  // the one widened READ scope: the caller's own tracks, or
  // Lounge-audible ones. Anything else (bogus / private / revoked / nonexistent)
  // is rejected here — no session row, no paid generation, unknown and revoked
  // indistinguishable. Only a readable seed that happens to lack a snapshot
  // falls back to deterministic default controls — never an LLM call.
  const seed = await getSeedSnapshot(db, { viewerUserId: ownerUserId, seedTrackIds });
  if (seed.kind === 'no-readable-seed') {
    return apiError('not_found', 'Seed track not found.');
  }
  const seedStyle =
    seed.kind === 'snapshot'
      ? seed.snapshot
      : toStoredSnapshot(await deriveSnapshotForIntent({ mode: 'controls', controls: {} }));
  // A FOREIGN seed is stripped of the sharer's personal ingredients
  // before anything is derived from its style, and any seed's own-voice opt-in
  // is read as the instance switch allows.
  const snapshot = honoredOwnVoice(
    seed.kind === 'snapshot' && seed.foreignSeed ? stripPersonalIngredients(seedStyle) : seedStyle,
  );

  // A seed that sings with the user's own voice must still be able to (the
  // profile may have been deleted/disabled since) — reject before any row or
  // spend rather than silently downgrading to generic vocals.
  if (snapshot.useOwnVoice === true) {
    const blocked = await ownVoiceBlockedMessage(db, ownerUserId);
    if (blocked) return apiError('validation_error', blocked);
  }

  // The same per-owner creation budget Start Session takes, for the same reason:
  // the naming call below is text-LLM spend no usage window counts. Taken after
  // the refusals above so a request that spends no LLM consumes no budget.
  const creates = sessionCreateLimiter.check(ownerUserId);
  if (!creates.allowed) return apiRateLimited(creates.retryAfterMs);

  // Naming: the seed snapshot arrives with the SOURCE session's creative naming,
  // which must not be cloned — `nameSeededSnapshot` names the new session fresh
  // (one non-blocking LLM call when configured, the source's names passed as
  // taken; the owner's listener profile is applied inside), deterministic
  // composition when not. The stored snapshot keeps every original vibe field —
  // only the naming (and a vocal seed's missing lyric context) is replaced.
  const [named, coverArtSettings, coverImageId, sessionMode] = await Promise.all([
    nameSeededSnapshot(db, ownerUserId, snapshot),
    getCoverArtSettings(db, ownerUserId),
    initialSessionCoverId(db),
    startingSessionMode(db, ownerUserId),
  ]);
  const { snapshot: stored, title, coverConcept, autoCoverStyle } = named;

  const { session: created, supersededSessionId } = await createSession(db, {
    ownerUserId,
    snapshot: stored,
    sessionMode,
    title,
    coverConcept,
    autoCoverStyle,
    ...(targetDurationMinutes != null ? { targetDurationMinutes } : {}),
    coverImageId,
    useStandardCover: coverArtSettings.useStandardCoverArt,
    ...resolveCoverArtChoiceFrom(
      coverArtSettings.customStyleDefinition,
      coverArtSettings.defaultStyle,
    ),
  });
  await launchSessionCreationKickoffs(db, created);

  return apiOk({ session: toSessionSummary(created), supersededSessionId });
}
