// `POST /api/sessions/more-like-this` → moreLikeThis.
//
// A track-seeded Start Session: creates a NEW session whose frozen Style Snapshot is
// reused from the seed track's originating session (no expansion call), superseding
// the active session (`endReason='superseded'`). Gated by the creation-time headroom
// check like Start Session: below the threshold NO session row is created. An
// optional context ("for cooking") rewrites the Name, titles, cover concept,
// activity and lyric notes through the seeded naming call, never the music, and
// becomes the Session's prompt history.

import { NextResponse } from 'next/server';
import { createSession, getCoverArtSettings, getSeedSnapshot } from '@liedmotif/db';
import { ProviderError, sessionStyleSnapshotSchema } from '@liedmotif/providers';
import { createLogger, moreLikeThisRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { getLlmProvider } from '@/lib/providers/providers';
import {
  apiError,
  apiOk,
  apiRateLimited,
  parseJsonBody,
  requireOwnerId,
} from '@/lib/http/api-response';
import { sessionCreateLimiter } from '@/lib/http/request-limits';
import {
  deriveSnapshotForIntent,
  nameSeededSnapshot,
  sessionCreationRefusal,
  startingSessionMode,
  stripPersonalIngredients,
  toSessionSummary,
  toStoredSnapshot,
} from '@/lib/sessions/sessions';
import {
  initialSessionCoverId,
  launchSessionCreationKickoffs,
  resolveCoverArtChoiceFrom,
} from '@/lib/covers/covers';
import { honoredOwnVoice, ownVoiceBlockedMessage } from '@/lib/voice/voice';

export const dynamic = 'force-dynamic';

const logger = createLogger({ name: 'more-like-this' });

/** A context's failed naming call is an expected, user-safe error; anything else is unexpected. */
function expectedNamingFailure(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  throw err;
}

const CONTEXT_NEEDS_TEXT_AI =
  'Adding a context needs a text AI. Set one up in Settings, or leave the context empty.';

const CONTEXT_NEEDS_READABLE_SEED =
  "This track's style can't be read, so it can't take a context. Leave the context empty.";

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
  const context = parsed.context || null;

  const db = getDb();

  const refusal = await sessionCreationRefusal(db, ownerUserId);
  if (refusal) return apiError(refusal.code, refusal.message);

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

  // A context only means something to the text LLM; without one it is refused,
  // never read deterministically or dropped (ADR 0004).
  if (context && !(await getLlmProvider())) {
    return apiError('validation_error', CONTEXT_NEEDS_TEXT_AI);
  }
  // A seed whose style does not parse keeps its stored naming, which would
  // ignore the context; no retry changes that, so it is refused, not retried.
  if (context && !sessionStyleSnapshotSchema.safeParse(snapshot).success) {
    return apiError('validation_error', CONTEXT_NEEDS_READABLE_SEED);
  }

  // The same per-owner creation budget Start Session takes, for the same reason:
  // the naming call below is text-LLM spend no usage window counts. Taken after
  // the refusals above so a request that spends no LLM consumes no budget.
  const creates = sessionCreateLimiter.check(ownerUserId);
  if (!creates.allowed) return apiRateLimited(creates.retryAfterMs);

  // Naming: the seed snapshot arrives with the SOURCE session's creative naming,
  // which must not be cloned — `nameSeededSnapshot` names the new session fresh
  // (one LLM call when configured, the source's names passed as taken; the
  // owner's listener profile is applied inside), deterministic composition when
  // not. The stored snapshot keeps every music field — only the naming, the lyric
  // notes and, with a context, the activity are replaced. Without a context the
  // call is cosmetic and never fails; with one it is required, and its failure
  // is a retryable error before any row or spend.
  const [named, coverArtSettings, coverImageId, sessionMode] = await Promise.all([
    nameSeededSnapshot(db, ownerUserId, snapshot, context).catch(expectedNamingFailure),
    getCoverArtSettings(db, ownerUserId),
    initialSessionCoverId(db),
    startingSessionMode(db, ownerUserId),
  ]);
  if (named instanceof ProviderError) {
    logger.warn('More Like This context naming failed', {
      providerErrorName: named.name,
      ...named.safeDetail,
    });
    return apiError('provider_error', named.message, { retryable: true });
  }
  const { snapshot: stored, title, coverConcept, autoCoverStyle, includesListener } = named;

  const { session: created, supersededSessionId } = await createSession(db, {
    ownerUserId,
    snapshot: stored,
    sessionMode,
    title,
    coverConcept,
    autoCoverStyle,
    includesListener,
    ...(context ? { userPrompt: context } : {}),
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
