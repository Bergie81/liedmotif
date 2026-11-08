// Owner-scoped Buffer settings are stored under the `generation` key. The
// worker reads the same object on every sweep, so changes apply within a tick.

import { NextResponse } from 'next/server';
import { getGenerationSettings, updateGenerationSettings } from '@liedmotif/db';
import { updateGenerationSettingsRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return apiOk(await getGenerationSettings(getDb(), ownerUserId));
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  // The shared schema is the single validation boundary for the enabled flag
  // and its 1–10 whole-Track target; the repo stores only parsed values.
  const patch = await parseJsonBody(
    request,
    updateGenerationSettingsRequestSchema,
    'Invalid generation settings.',
  );
  if (patch instanceof NextResponse) return patch;

  return apiOk(await updateGenerationSettings(getDb(), { ownerUserId, patch }));
}
