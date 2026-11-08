// Admin-only: the Unit costs — the Admin's price per Track and per Cover that
// Estimated cost readouts multiply by. A Member
// never reads them: money is an Admin-only surface.

import { getUnitCosts, updateUnitCosts } from '@liedmotif/db';
import { unitCostsSchema, updateUnitCostsRequestSchema } from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { apiError, apiOk, parseJsonBody, requireAdminOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return apiOk({ unitCosts: await getUnitCosts(getDb()) });
}

export async function POST(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const patch = await parseJsonBody(request, updateUnitCostsRequestSchema, 'Invalid unit costs.');
  if (patch instanceof NextResponse) return patch;

  const db = getDb();
  // Validate the MERGED object, persist only the patch: writing the merge back
  // would restate the other price and overwrite whatever another tab saved.
  const merged = unitCostsSchema.safeParse({ ...(await getUnitCosts(db)), ...patch });
  if (!merged.success) {
    return apiError('validation_error', 'Invalid unit costs.', {
      details: merged.error.flatten(),
    });
  }

  return apiOk({ unitCosts: await updateUnitCosts(db, patch) });
}
