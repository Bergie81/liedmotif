// Admin-only: a single Member's personal budget (`user_settings['limits']`).
// The Admin writes another user's owner-scoped row here — the target must BE a
// Member; the Admin's own caps live in `usageLimits` and are not editable via
// this route.

import {
  getMemberLimits,
  getMembersPool,
  listMemberLimits,
  updateMemberLimits,
} from '@liedmotif/db';
import {
  foreignKindFields,
  memberLimitsSchema,
  poolOverSubscription,
  updateMemberLimitsRequestSchema,
} from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { apiError, apiOk, parseJsonBody } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { requireAdminAndMember } from '../../member-route';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const target = await requireAdminAndMember(request, params);
  if (target instanceof NextResponse) return target;
  return apiOk({ limits: await getMemberLimits(getDb(), target.memberUserId) });
}

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const target = await requireAdminAndMember(request, params);
  if (target instanceof NextResponse) return target;
  const { memberUserId } = target;

  const body = await parseJsonBody(
    request,
    updateMemberLimitsRequestSchema,
    'Invalid member budget patch.',
  );
  if (body instanceof NextResponse) return body;

  const db = getDb();
  const stored = await getMemberLimits(db, memberUserId);
  const kind = body.kind ?? stored.kind;
  const foreign = foreignKindFields(kind, body);
  if (foreign.length > 0) {
    return apiError('validation_error', `Not a ${kind} budget field: ${foreign.join(', ')}.`);
  }
  // The Grant moves only with the kind: a top-up of a
  // One-time total keeps counting from the same instant.
  const patch =
    body.kind !== undefined && body.kind !== stored.kind
      ? { ...body, grantedAt: new Date().toISOString() }
      : body;
  // Cross-field rules (monthly >= daily) hold on the MERGED object; only the
  // patch is persisted, because writing the merged object back would restate
  // every field from this read and overwrite whatever another tab saved
  // meanwhile.
  const merged = memberLimitsSchema.safeParse({ ...stored, ...patch });
  if (!merged.success) {
    return apiError('validation_error', 'Invalid member budget.', {
      details: merged.error.flatten(),
    });
  }

  const limits = await updateMemberLimits(db, { ownerUserId: memberUserId, patch });
  // Over-subscription is a warning the UI shows, never a refusal.
  const [pool, members] = await Promise.all([getMembersPool(db), listMemberLimits(db)]);
  return apiOk({
    limits,
    overSubscription: poolOverSubscription(
      members.map((member) => member.limits),
      pool,
    ),
  });
}
