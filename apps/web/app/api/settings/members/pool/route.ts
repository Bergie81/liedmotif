// Admin-only: the Members Pool — the shared budget ceiling over ALL Members
//. Over-subscription (Σ member budgets > Pool) is allowed and
// reported as a warning, never a refusal.

import { getMembersPool, listMemberLimits, updateMembersPool, type Database } from '@liedmotif/db';
import {
  membersPoolSchema,
  poolOverSubscription,
  updateMembersPoolRequestSchema,
  type MembersPool,
  type PoolOverSubscription,
} from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { apiError, apiOk, parseJsonBody, requireAdminOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

async function overSubscription(db: Database, pool: MembersPool): Promise<PoolOverSubscription[]> {
  const members = await listMemberLimits(db);
  return poolOverSubscription(
    members.map((member) => member.limits),
    pool,
  );
}

export async function GET(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const db = getDb();
  const pool = await getMembersPool(db);
  return apiOk({ pool, overSubscription: await overSubscription(db, pool) });
}

export async function POST(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const patch = await parseJsonBody(
    request,
    updateMembersPoolRequestSchema,
    'Invalid members pool patch.',
  );
  if (patch instanceof NextResponse) return patch;

  const db = getDb();
  // Cross-field rules (monthly >= daily) hold on the MERGED object — a partial
  // patch alone cannot see the field it must stay consistent with. Only the
  // patch is persisted, though: writing the merged object back would restate
  // every field from this read and overwrite whatever another tab saved
  // meanwhile.
  const merged = membersPoolSchema.safeParse({ ...(await getMembersPool(db)), ...patch });
  if (!merged.success) {
    return apiError('validation_error', 'Invalid members pool.', {
      details: merged.error.flatten(),
    });
  }

  const pool = await updateMembersPool(db, patch);
  return apiOk({ pool, overSubscription: await overSubscription(db, pool) });
}
