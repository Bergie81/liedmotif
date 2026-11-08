// `POST /api/listening/report` → recordListening.
//
// Personal analytics only: this never marks a Session as listened-to,
// never feeds the Buffer gate, and the player ignores its outcome. Idempotent via
// `occurrenceId` + cumulative totals, so any report is safe to retry or drop.

import { NextResponse } from 'next/server';
import { recordListening } from '@liedmotif/db';
import { reportListeningRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const report = await parseJsonBody(
    request,
    reportListeningRequestSchema,
    'Invalid listening report.',
  );
  if (report instanceof NextResponse) return report;

  const result = await recordListening(getDb(), {
    ownerUserId,
    occurrenceId: report.occurrenceId,
    trackId: report.trackId,
    sessionId: report.sessionId,
    surface: report.surface,
    startedAt: new Date(report.startedAt),
    origin: report.origin,
    listenedMs: report.listenedMs,
    playedMs: report.playedMs,
    clientTimestamp: new Date(report.clientTimestamp),
    endReason: report.endReason,
  });
  if (!result.ok) {
    return result.reason === 'not_found'
      ? apiError('not_found', 'Track not found.')
      : apiError('validation_error', 'Listening report is not plausible.');
  }
  return apiOk({ accepted: true as const });
}
