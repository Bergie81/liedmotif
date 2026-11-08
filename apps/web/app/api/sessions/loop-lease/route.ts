// `POST /api/sessions/loop-lease` — the repeat-one loop hold. ACKNOWLEDGED by
// design: the response carries the applied state, so the client reflects the
// server's truth instead of assuming its fire-and-forget message landed. The
// epoch/clientId rules live in `applyLoopLease` (`@liedmotif/db`); the buffer
// sweep skips paid prefill while a live lease exists.

import { NextResponse } from 'next/server';
import { applyLoopLease } from '@liedmotif/db';
import { loopLeaseRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiError, apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const parsed = await parseJsonBody(
    request,
    loopLeaseRequestSchema,
    'Invalid loop-lease request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const result = await applyLoopLease(getDb(), {
    ownerUserId,
    sessionId: parsed.sessionId,
    clientId: parsed.clientId,
    epoch: parsed.epoch,
    action: parsed.action,
  });
  if (!result.ok) return apiError('not_found', 'Session not found.');

  const { held, lease } = result.state;
  return apiOk({
    applied: result.applied,
    held,
    lease: lease
      ? { epoch: lease.epoch, expiresAt: lease.expiresAt.toISOString(), released: lease.released }
      : null,
  });
}
