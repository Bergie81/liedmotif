// `POST /api/sessions/playback` → reportPlaybackState.
//
// Applies a playback report to the owner's session: a fresh/landing report makes its
// reporter the active playback client (a Session has one controller) and updates the
// live fields; a deduped persisted retry changes nothing. started/ended/skipped/failed
// persist a `playback_events` row (a `position` ping updates live fields only — no row).
//
// Idempotent via `clientEventId`: a retried report reuses the same key, so persisted
// events (started/ended/skipped/failed) dedupe on the unique
// (activity_session_id, client_event_id) index and never double-count; position pings
// update live fields only (no row).
//
// LIMITATION (documented for the orchestrator): web has no Graphile client, so buffer
// top-up is driven by the worker `sweep-active-sessions` job, not enqueued here —
// `bufferEnqueued` reports whether the event WARRANTS a top-up (which the sweep
// performs), and is false for deduped retries.

import { NextResponse } from 'next/server';
import { reportPlaybackState } from '@liedmotif/db';
import { reportPlaybackStateRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const report = await parseJsonBody(
    request,
    reportPlaybackStateRequestSchema,
    'Invalid playback report.',
  );
  if (report instanceof NextResponse) return report;

  const result = await reportPlaybackState(getDb(), {
    ownerUserId,
    sessionId: report.sessionId,
    clientId: report.clientId,
    clientEventId: report.clientEventId,
    type: report.type,
    trackId: report.trackId,
    queueItemId: report.queueItemId,
    positionSeconds: report.positionSeconds,
    clientTimestamp: new Date(report.clientTimestamp),
    queueWrapped: report.queueWrapped ?? false,
    shuffled: report.shuffled ?? false,
  });
  if (!result.ok) {
    if (result.reason === 'not_found') return apiError('not_found', 'Session not found.');
    // A queueItemId / trackId that is not part of this session/owner (IDOR).
    return apiError(
      'validation_error',
      'Playback report references a track or queue item that is not part of this session.',
    );
  }

  return apiOk({
    accepted: true as const,
    persistedEvent: result.persistedEvent,
    bufferEnqueued: result.bufferEnqueued,
    activePlaybackClientId: result.activePlaybackClientId,
  });
}
