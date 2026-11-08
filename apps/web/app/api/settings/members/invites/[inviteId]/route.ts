// Admin-only: revoke an outstanding invite. Consumed or already-revoked links
// answer not_found — there is nothing left to take back.

import { revokeInvite } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { apiError, apiOk, requireAdminOwnerId, validateInput } from '@/lib/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ inviteId: string }> },
) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const inviteId = validateInput(uuidSchema, (await params).inviteId, 'Invalid invite id.');
  if (inviteId instanceof NextResponse) return inviteId;

  const revoked = await revokeInvite(getDb(), { id: inviteId });
  if (!revoked) return apiError('not_found', 'No open invite to revoke.');
  return apiOk({ revoked: true });
}
