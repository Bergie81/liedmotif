// `GET /api/sessions/queue` → getSessionQueue.
//
// The server-authoritative queue (the single source of truth for play order). Each
// item resolves its track for the player; audio is exposed ONLY as a same-origin
// app path (`/api/audio/<id>`, served in a later phase) — provider/stream URLs never
// reach the browser. The generation-controller state rides alongside the
// two-value session status so the player can render "why generation isn't producing".

import { NextResponse } from 'next/server';
import {
  getSessionQueue,
  type QueueSessionRecord,
  type SessionQueuePendingGeneration,
  type SessionQueueTrack,
  type SessionQueueView,
} from '@liedmotif/db';
import {
  ENERGY_LEVELS,
  VOICE_GENDERS,
  getSessionQueueRequestSchema,
  isDurationTargetReached,
  narrowTo,
  pendingGenerationStage,
  phantomSubmitCutoffAt,
  structuredControlsSchema,
  toBlendAnalysis,
  type PendingGeneration,
  type SessionVibe,
} from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { ownVoiceEnabled } from '@/lib/env';
import { apiError, apiOk, requireOwnerId, validateInput } from '@/lib/api-response';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers';
import { toTrackSummary } from '@/lib/tracks';

export const dynamic = 'force-dynamic';

/**
 * The pinned per-source audio paths: each serves exactly that asset or 404s, so
 * the deck ladder can infer the committed source kind from which pinned URL
 * succeeded. Same-origin app paths only.
 */
function toQueueItemAssets(track: SessionQueueTrack | null) {
  // A failed Track's final never arrives; its stream stays stored only so a
  // Track playing right now can finish through the audio route.
  if (track?.status === 'failed') return { final: null, stream: null };
  return {
    final: track?.hasFinalAsset ? `/api/audio/${track.id}?asset=final` : null,
    stream: track?.hasStreamAsset ? `/api/audio/${track.id}?asset=stream` : null,
  };
}

/**
 * Map the repo's raw pending-generation state to the contract payload: the
 * coarse stage + submit timestamp ONLY (never task ids, URLs, or prompts).
 * A status with no stage (failed/blocked) maps to null — the banner owns it.
 */
function toPendingGeneration(
  pending: SessionQueuePendingGeneration | null,
): PendingGeneration | null {
  if (!pending) return null;
  const stage = pendingGenerationStage(pending.normalizedStatus);
  if (!stage) return null;
  return {
    stage,
    submittedAt: pending.submittedAt.toISOString(),
    trackTitle: pending.earlyTrackTitle,
  };
}

/** A stored guardrail level, or null when the snapshot predates guardrails —
 *  the overlay shows the domain default for a null and never a made-up number. */
function storedGuardrailLevel(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The Change Vibe overlay's preselection source: a fixed set of facets from the
 * session's current Style Snapshot — the vibe's shape plus its frozen
 * Guardrails — and the stored free-text intent. The repo
 * extracts the facets in SQL (the snapshot's internals — style prompt, lyric
 * context, seeds — never leave the database on this poll); the narrowing here
 * stays defensive because the stored values are unvalidated JSON.
 */
function toSessionVibe(session: QueueSessionRecord): SessionVibe | null {
  const facets = session.styleFacets;
  if (!facets) return null;
  const parsedControls = session.structuredControls
    ? structuredControlsSchema.safeParse(session.structuredControls)
    : null;
  return {
    genreTags: Array.isArray(facets.genreTags)
      ? facets.genreTags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    energy: narrowTo(ENERGY_LEVELS, facets.energy),
    vocalMode: facets.vocalMode === 'vocal' ? 'vocal' : 'instrumental',
    voiceGender: narrowTo(VOICE_GENDERS, facets.voiceGender),
    // The sheet seeds its picks from this, so a switched-off feature reads as
    // the generic singer here too.
    ownVoice: ownVoiceEnabled() && facets.useOwnVoice === true,
    language: typeof facets.language === 'string' ? facets.language : '',
    styleStrength: storedGuardrailLevel(facets.styleStrength),
    novelty: storedGuardrailLevel(facets.novelty),
    avoid: typeof facets.userAvoid === 'string' ? facets.userAvoid : '',
    userPrompt: session.userPrompt,
    controls: parsedControls?.success ? parsedControls.data : null,
  };
}

/**
 * An armed switch-now is pending only while its revision's fill can still
 * arrive: new-vibe work in flight, or a fill the worker still owes. At the
 * duration target it owes none, and in Repeat it owes only the
 * revision's one initial batch, so a spent fill — even a failed one — ends the
 * wait. Otherwise the player would promise a cutover that never comes.
 */
function vibeSwitchPending(view: SessionQueueView): boolean {
  const { session } = view;
  if (session.vibeSwitchRevision == null) return false;
  if (view.generatingNewVibeTracksAhead > 0) return true;
  if (isDurationTargetReached(session.targetDurationMinutes, session.generatedDurationSeconds)) {
    return false;
  }
  return session.sessionMode === 'keep_going' || !session.liveRevisionFillSpent;
}

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const url = new URL(request.url);
  const parsed = validateInput(
    getSessionQueueRequestSchema,
    { sessionId: url.searchParams.get('sessionId') },
    'Invalid queue request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const tracksPerRequest = getTypicalTracksPerMusicRequest();
  const view = await getSessionQueue(getDb(), {
    ownerUserId,
    sessionId: parsed.sessionId,
    phantomSubmitCutoff: phantomSubmitCutoffAt(),
    tracksPerRequest,
  });
  if (!view) return apiError('not_found', 'Session not found.');

  return apiOk({
    sessionId: view.session.id,
    targetDurationMinutes: view.session.targetDurationMinutes,
    generatedDurationSeconds: view.session.generatedDurationSeconds,
    unknownDurationTrackCount: view.session.unknownDurationTrackCount,
    sessionStatus: view.session.status,
    sessionMode: view.session.sessionMode,
    generationStatus: view.session.generationStatus,
    generationStatusScope: view.session.generationStatusScope,
    statusMessageSafe: view.session.statusMessageSafe,
    coverImageId: view.session.coverImageId,
    // The live revision the player compares against a loop pin's track (a
    // Change Vibe bumps it atomically with the snapshot replacement).
    styleRevision: view.session.styleRevision,
    currentTrackId: view.session.currentTrackId,
    currentQueueItemId: view.session.currentQueueItemId,
    // Playable Tracks the windowed read elided before `items`.
    earlierTracks: view.earlierTracks,
    items: view.items.map((item) => ({
      id: item.id,
      position: item.position,
      state: item.state,
      vibeSwitchSetAside: item.vibeSwitchSetAside,
      trackId: item.trackId,
      // The queue exposes audio on asset presence alone: its items resolve
      // per-source pins (`toQueueItemAssets`), unlike the library's
      // status-gated single URL.
      track: item.track ? toTrackSummary(item.track, { assetPresenceOnly: true }) : null,
      // Generation-time blend identity from the slot's request; null on
      // legacy/pre-plan requests (a null identity always forces a plain edge).
      targetBpm: item.targetBpm,
      targetKey: item.targetKey,
      styleRevision: item.styleRevision,
      durationSeconds: item.track?.durationSeconds ?? null,
      assets: toQueueItemAssets(item.track),
      // Stale analyzer versions are suppressed here (`toBlendAnalysis` returns
      // null below the current version) — the client never mixes versions.
      blendAnalysis: item.track ? toBlendAnalysis(item.track.analysis) : null,
    })),
    // What the session's in-flight provider work still owes, in Tracks: the
    // player's "Generating" count, and the part of it carrying the live revision.
    generatingTracksAhead: view.generatingTracksAhead,
    generatingNewVibeTracksAhead: view.generatingNewVibeTracksAhead,
    pendingGeneration: toPendingGeneration(view.pendingGeneration),
    vibe: toSessionVibe(view.session),
    // Armed switch-now Change Vibe: the player narrates the wait and triggers
    // its early advance when the post-cutover queue arrives (the flag drops
    // back to false in the same poll that delivers that queue).
    switchPending: vibeSwitchPending(view),
    // A content block refuses the same request again, so retrying it would be
    // pointless; Change Vibe is that banner's way forward.
    tryAgainTracks:
      view.pendingGeneration?.normalizedStatus === 'blocked_by_policy' ? null : tracksPerRequest,
  });
}
