// Admin-only: one Member's own Assistant access (`user_settings['assistant']`).
// The target must BE a Member: the Admin has no access switch and no daily
// allowance. `null` takes a field back to the instance default.

import { updateMemberAssistantAccess } from '@liedmotif/db';
import { updateMemberAssistantAccessRequestSchema } from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { apiOk, parseJsonBody } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { requireAdminAndMember } from '../../member-route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const target = await requireAdminAndMember(request, params);
  if (target instanceof NextResponse) return target;

  const patch = await parseJsonBody(
    request,
    updateMemberAssistantAccessRequestSchema,
    'Invalid Assistant access.',
  );
  if (patch instanceof NextResponse) return patch;

  const access = await updateMemberAssistantAccess(getDb(), {
    ownerUserId: target.memberUserId,
    patch,
  });
  return apiOk({ access });
}
