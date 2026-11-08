// `GET    /api/surprise-me` → the caller's pending Surprise Me proposal, if any
// `POST   /api/surprise-me` → propose (or Try another): one bounded text-LLM call
// `DELETE /api/surprise-me` → dismiss the proposal the caller is showing
//
// A proposal is a preview: no Session, music-model request or cover
// is created here. Only the public preview is returned — the stored Style
// Snapshot and lyric direction stay server-side.

import { NextResponse } from 'next/server';
import { dismissPendingProposal } from '@liedmotif/db';
import { dismissSurpriseRequestSchema, proposeSurpriseRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, apiRateLimited, parseJsonBody, requireOwnerId } from '@/lib/api-response';
import { loadPendingSurprise, proposeSurprise } from '@/lib/surprise-me';

export const dynamic = 'force-dynamic';

/** How soon a double tap may try again once the first proposal has answered. */
const BUSY_RETRY_AFTER_MS = 3_000;

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return apiOk({ proposal: await loadPendingSurprise(getDb(), ownerUserId) });
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(
    request,
    proposeSurpriseRequestSchema,
    'Invalid Surprise Me request.',
  );
  if (body instanceof NextResponse) return body;

  const result = await proposeSurprise(getDb(), {
    ownerUserId,
    adventurous: body.adventurous ?? false,
    skipProfile: body.skipProfile ?? false,
    theme: body.theme,
    vocal: body.vocal,
    language: body.language,
    replaces: body.replaces,
    signal: request.signal,
  });
  if (result.ok) return apiOk({ proposal: result.proposal });
  switch (result.reason) {
    case 'headroom_blocked':
      return apiError('session_headroom_blocked', result.message);
    case 'provider_error':
      return apiError('provider_error', result.message, { retryable: true });
    case 'stale':
      return apiError('conflict', result.message, { retryable: result.retryable });
    case 'cancelled':
      return apiError('conflict', result.message);
    case 'busy':
      return apiRateLimited(BUSY_RETRY_AFTER_MS);
    case 'rate_limited':
      return apiRateLimited(result.retryAfterMs);
  }
}

export async function DELETE(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(
    request,
    dismissSurpriseRequestSchema,
    'Invalid Surprise Me request.',
  );
  if (body instanceof NextResponse) return body;

  const dismissed = await dismissPendingProposal(getDb(), {
    ownerUserId,
    proposalId: body.proposalId,
  });
  if (!dismissed) return apiError('not_found', 'That suggestion is no longer pending.');
  return apiOk({ dismissed: true as const });
}
