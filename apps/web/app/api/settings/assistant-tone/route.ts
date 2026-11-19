// The tone a user gives the Assistant. The Assistant reads it on every
// message, so a saved tone holds from the next one.

import { NextResponse } from 'next/server';
import { updateAssistantTone } from '@liedmotif/db';
import { assistantToneSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiOk, parseJsonBody, requireOwnerId } from '@/lib/http/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const patch = await parseJsonBody(request, assistantToneSchema, 'Invalid tone.');
  if (patch instanceof NextResponse) return patch;

  return apiOk(await updateAssistantTone(getDb(), { ownerUserId, patch }));
}
