// `POST /api/sessions/change-vibe` → changeVibe.
//
// Re-styles the CURRENT session in place: same identity, stays `active`,
// new Style Snapshot derived from the new intent (template for controls; the text
// LLM for free text when configured, deterministic prompt passthrough otherwise).
// A picks-only intent adjusts the current snapshot by its picks alone: one text-LLM
// call with no change message, or the picks applied deterministically without one.
// The only steering action; never creates a second session.
// The live Change Vibe boundary is a crossfade in the player (no provider call).
//
// A change arms a new revision whose initial fill is one music-model call, so it
// is refused only when not even that call fits the owner's budgets (the money
// gate the worker submits through) — not the creation headroom, which exists so
// a new Session has enough Tracks to Repeat. At the Session duration target the
// fill is blocked too, so the change is refused there unless the same
// edit lifts or clears the target. A Stopped Session never fills a revision, so
// it is refused too, and so is every change while the Admin has paused all new
// music. These checks run ahead of the derivation, so a change that could
// produce no music spends no LLM either. Past them a per-owner rate limit bounds
// the derivation itself, which no music budget counts.

import { NextResponse } from 'next/server';
import { getSessionById, restyleSession } from '@liedmotif/db';
import {
  changeVibeRequestSchema,
  createLogger,
  DURATION_TARGET_REACHED_MESSAGE,
  isDurationTargetReached,
  type ChangeVibeIntentInput,
} from '@liedmotif/shared';
import { sessionStyleSnapshotSchema, type SessionIntentInput } from '@liedmotif/providers';
import { getDb } from '@/lib/db';
import { apiError, apiOk, apiRateLimited, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import {
  deriveNamedSnapshotForIntent,
  evaluateGenerationBudget,
  headroomRefusalMessage,
  newMusicPausedRefusal,
  toSessionSummary,
} from '@/lib/sessions';
import { changeVibeLimiter } from '@/lib/request-limits';
import { enqueueEnsureSessionBuffer } from '@/lib/worker-jobs';
import { honoredOwnVoice, intentRequestsOwnVoice, ownVoiceBlockedMessage } from '@/lib/voice';

export const dynamic = 'force-dynamic';

const logger = createLogger({ name: 'change-vibe' });

const UNREADABLE_STYLE_MESSAGE =
  "This Session's current style could not be read. Describe the change in words instead.";

/** A vibe change changes direction, not language: for an intent without a
 * language pick the running session's language rides along as an explicit pick
 * (a server-side fallback for API callers without the overlay's preselection).
 * A concrete pick is authoritative on both branches. The `'auto'` marker carries
 * nothing and is stripped (`autoLanguage`), so the derivation re-detects the
 * language — which may resolve the same one again. The `'any'` voice marker is
 * stripped the same way (`anyVoice`): the anchor's voice is released instead. */
function resolveIntentMarkers(
  input: ChangeVibeIntentInput,
  language: string | undefined,
): { input: SessionIntentInput; autoLanguage: boolean; anyVoice: boolean } {
  const pick = input.mode === 'controls' ? input.controls.language : input.language;
  const autoLanguage = pick === 'auto';
  const carried = autoLanguage ? undefined : (pick ?? language);
  function withCarried<T extends object>(fields: T) {
    return carried ? { ...fields, language: carried } : fields;
  }
  if (input.mode !== 'controls') {
    const { language: _pick, voice, ...rest } = input;
    const anyVoice = voice === 'any';
    const picked = voice === undefined || anyVoice ? rest : { ...rest, voice };
    return { input: withCarried(picked), autoLanguage, anyVoice };
  }
  const { language: _pick, ...controls } = input.controls;
  return {
    input: { mode: 'controls', controls: withCarried(controls) },
    autoLanguage,
    anyVoice: false,
  };
}

/** A vibe change changes direction, not the singer: when the running session
 * sings with the user's own voice and the intent does not touch the vocal
 * group, the opt-in rides along as an explicit pick — it is honored only on a
 * vocal result, so "make it instrumental" still wins. An intent carrying its
 * own vocal/own-voice picks is authoritative. */
function carrySessionOwnVoice(input: SessionIntentInput, useOwnVoice: boolean): SessionIntentInput {
  if (!useOwnVoice) return input;
  if (input.mode !== 'controls') {
    return input.vocal !== undefined || input.ownVoice !== undefined
      ? input
      : { ...input, ownVoice: true };
  }
  return input.controls?.vocal !== undefined || input.controls?.ownVoice !== undefined
    ? input
    : { ...input, controls: { ...input.controls, vocal: 'vocal', ownVoice: true } };
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    changeVibeRequestSchema,
    'Invalid Change Vibe request.',
  );
  if (parsed instanceof NextResponse) return parsed;
  const { sessionId, input: rawInput, switchImmediately, targetDurationMinutes } = parsed;

  const db = getDb();
  // The gates are free reads with no data dependency on the session, so they
  // ride alongside it — and the session still answers first, keeping an unowned
  // id a 404 rather than a refusal that admits it exists (the IDOR posture).
  const [current, paused, budget] = await Promise.all([
    getSessionById(db, { ownerUserId, sessionId }),
    newMusicPausedRefusal(db, ownerUserId),
    evaluateGenerationBudget(db, ownerUserId),
  ]);
  if (!current) return apiError('not_found', 'Session not found.');
  // `restyleSession` re-checks under its lock for a stop inside the derivation.
  if (current.status !== 'active') {
    return apiError('conflict', 'Change Vibe needs an active session.');
  }
  if (paused) return apiError('new_music_paused', paused);
  if (!budget.withinLimits) {
    return apiError('session_headroom_blocked', await headroomRefusalMessage(db, budget));
  }
  const effectiveTarget =
    targetDurationMinutes !== undefined ? targetDurationMinutes : current.targetDurationMinutes;
  if (isDurationTargetReached(effectiveTarget, current.generatedDurationSeconds)) {
    return apiError('session_duration_reached', DURATION_TARGET_REACHED_MESSAGE);
  }
  // Read once, as the switch allows: every carry and the derivation anchor
  // below see the same singer.
  const runningStyle =
    current.sessionStyleSnapshot && honoredOwnVoice(current.sessionStyleSnapshot);
  const {
    input: markersResolved,
    autoLanguage,
    anyVoice,
  } = resolveIntentMarkers(rawInput, runningStyle?.language);
  const input = carrySessionOwnVoice(markersResolved, runningStyle?.useOwnVoice === true);

  // "Use my voice" is honored or rejected — never silently downgraded (the
  // profile may have been deleted/disabled since the session started).
  if (intentRequestsOwnVoice(input)) {
    const blocked = await ownVoiceBlockedMessage(db, ownerUserId);
    if (blocked) return apiError('validation_error', blocked);
  }

  // Change Vibe is an ADJUSTMENT, not a restart: the running snapshot anchors the
  // derivation, so a free-text change alters only what the request (and the explicit
  // picks) asks for and everything else — genres, language, vocals, frozen bpm/key,
  // and the personal lyric notes (edited in place, never rebuilt) — stays as close as
  // possible; the session's creative naming rides through unchanged on either mode,
  // and the Session Name is never touched, Derived or Given.
  const anchor = sessionStyleSnapshotSchema.safeParse(runningStyle);
  if (!anchor.success) {
    // Picks alone have nothing to adjust without a readable current style.
    if (input.mode === 'picks') return apiError('validation_error', UNREADABLE_STYLE_MESSAGE);
    // Degrades to an un-anchored derivation (a fresh expansion) — worth a trace,
    // since the user experiences it as a much bigger change than they asked for.
    logger.warn('stored snapshot unparseable; deriving the vibe change without its anchor', {
      sessionId,
    });
  }
  // The last gate, and the only one that meters the text LLM: the budget windows
  // count music tasks, so nothing else bounds the derivation below. Taken after
  // every free refusal so a request that reaches no derivation consumes none,
  // and whether or not a text LLM is configured.
  const changes = changeVibeLimiter.check(ownerUserId);
  if (!changes.allowed) return apiRateLimited(changes.retryAfterMs);

  // The owner's listener profile is applied inside — the route never handles it. A
  // session started without the profile stays without it (the stored flag, not a
  // client resend, is authoritative).
  const derived = await deriveNamedSnapshotForIntent(db, ownerUserId, input, {
    skipProfile: current.skipProfile,
    // A change message says only what changes: whether the request includes the
    // listener starts from the stored answer, anchored or not.
    includesListener: current.includesListener,
    // The prompt history rides only WITH the anchor: it is background context for
    // the wording those facets were distilled from, so an edit can recover names and
    // story details the bounded lyric notes dropped — and with nothing to edit it
    // would merely re-apply requests the snapshot has already superseded.
    ...(anchor.success
      ? {
          // Auto Detect and the Any voice release the anchored facet too, or
          // the adjustment (which holds every facet the request leaves alone)
          // would keep it.
          adjustFrom: {
            ...anchor.data,
            ...(autoLanguage ? { language: '' } : {}),
            ...(anyVoice ? { voiceGender: '' } : {}),
          },
          promptHistory: current.userPrompt ?? undefined,
        }
      : {}),
  });
  if (!derived.ok) {
    return apiError('provider_error', derived.message, { retryable: true });
  }
  const { userPrompt, coverConcept, autoCoverStyle } = derived;
  // Auto Detect on a picks-only change has no new words to detect from: when the
  // adjustment names no language, the Session keeps the one it had.
  const snapshot =
    input.mode === 'picks' && autoLanguage && !derived.snapshot.language
      ? { ...derived.snapshot, language: runningStyle?.language ?? '' }
      : derived.snapshot;
  const result = await restyleSession(db, {
    ownerUserId,
    sessionId,
    snapshot,
    // The Auto pick follows the concept it was written with (ADR 0007). A reply
    // without a concept keeps both: a small adjustment leaves the existing cover
    // direction relevant, and the preserved naming skips the naming call. A
    // picks-only change keeps both whatever the reply: picks move the sound,
    // never the cover direction.
    ...(coverConcept && input.mode !== 'picks'
      ? { coverConcept, autoCoverStyle: autoCoverStyle ?? current.autoCoverStyle }
      : {}),
    includesListener: derived.includesListener,
    // Provenance: the message EXTENDS the session's prompt history, which each
    // generation request then freezes for the Tracks it produces.
    userPromptAddition: userPrompt,
    // A controls change stores its controls and a message clears them; a
    // picks-only change leaves them as they are, so a Session never turns
    // controls-born behind the listener's back.
    ...(input.mode === 'picks'
      ? {}
      : { structuredControls: input.mode === 'controls' ? input.controls : null }),
    switchImmediately,
    targetDurationMinutes,
  });
  if (!result.ok) {
    if (result.reason === 'not_found') return apiError('not_found', 'Session not found.');
    return apiError('conflict', 'Change Vibe needs an active session.');
  }

  // Kick the buffer so the first new-vibe generation does not wait for the
  // minute sweep. Best-effort (never fails the request); the controller's own
  // watermark and budget checks decide whether anything is actually submitted.
  // That tick is also where pending rerolls of the replaced vibe are cancelled
  // (one cancellation point, as for Repeat).
  await enqueueEnsureSessionBuffer(db, sessionId);

  return apiOk({ session: toSessionSummary(result.session) });
}
