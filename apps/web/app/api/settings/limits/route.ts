// Admin-only: update the instance cost limits (the `usageLimits` object).

import { NextResponse } from 'next/server';
import { updateUsageLimits, type UsageLimits } from '@liedmotif/db';
import { NUMERIC_LIMIT_KEYS, USAGE_LIMIT_CEILINGS, usageLimitFloor } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { badRequest } from '@/lib/http';
import { readJsonObjectBody, requireAdminOwnerId } from '@/lib/api-response';
import { isSupportedTimezone } from '@/lib/timezones';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const admin = await requireAdminOwnerId(request);
  if (admin instanceof NextResponse) return admin;

  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;

  const patch: Partial<UsageLimits> = {};
  for (const key of NUMERIC_LIMIT_KEYS) {
    const value = body[key];
    if (value === undefined) continue;
    // Strict: only an actual number updates a limit. Coercing here would turn
    // `""`/`null` into 0 and silently zero a cost limit; a caller that
    // means 0 must send the number 0.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return badRequest(`${key} must be a non-negative whole number.`);
    }
    const floor = usageLimitFloor(key);
    if (value < floor) {
      return badRequest(`${key} must be at least ${floor}.`);
    }
    // Without a ceiling one request stores a limit no spend can reach, which is
    // the "cost controls on by default" invariant switched off from the inside.
    if (value > USAGE_LIMIT_CEILINGS[key]) {
      return badRequest(`${key} must be at most ${USAGE_LIMIT_CEILINGS[key]}.`);
    }
    patch[key] = value;
  }

  // The reset timezone moves the daily/monthly window boundary, so an unknown zone
  // is refused rather than stored — `limitWindowStarts` would throw on it later.
  if (body.resetTimezone !== undefined) {
    if (typeof body.resetTimezone !== 'string' || !isSupportedTimezone(body.resetTimezone)) {
      return badRequest('resetTimezone must be a known IANA timezone.');
    }
    patch.resetTimezone = body.resetTimezone;
  }

  if (typeof body.trackCeilingEnabled === 'boolean') {
    patch.trackCeilingEnabled = body.trackCeilingEnabled;
  }
  if (typeof body.coverCeilingEnabled === 'boolean') {
    patch.coverCeilingEnabled = body.coverCeilingEnabled;
  }
  if (typeof body.manualGenerationOnly === 'boolean') {
    patch.manualGenerationOnly = body.manualGenerationOnly;
  }
  if (typeof body.tailoredCoverArtEnabled === 'boolean') {
    patch.tailoredCoverArtEnabled = body.tailoredCoverArtEnabled;
  }

  const limits = await updateUsageLimits(getDb(), patch);
  return NextResponse.json({ ok: true, limits });
}
