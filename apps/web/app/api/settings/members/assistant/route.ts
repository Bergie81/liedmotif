// Admin-only: the instance default for Assistant access — whether Members have
// the Assistant and how many messages a day. Every Member follows it for each
// field the Admin has not set for them.

import { updateAssistantAccess } from '@liedmotif/db';
import { updateAssistantAccessRequestSchema } from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { apiOk, parseJsonBody, requireAdminOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const adminUserId = await requireAdminOwnerId(request);
  if (adminUserId instanceof NextResponse) return adminUserId;

  const patch = await parseJsonBody(
    request,
    updateAssistantAccessRequestSchema,
    'Invalid Assistant access.',
  );
  if (patch instanceof NextResponse) return patch;

  return apiOk({ access: await updateAssistantAccess(getDb(), patch) });
}
