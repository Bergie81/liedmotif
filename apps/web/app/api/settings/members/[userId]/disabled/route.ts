// Admin-only: disable / re-enable a Member. Immediate (guards re-read the
// profile per request) and reversible — everything the Member owns is kept.
// Disabling also revokes their live login rows.

import { setMemberDisabled } from '@liedmotif/db';
import { setMemberDisabledRequestSchema } from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { apiError, apiOk, parseJsonBody } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { NO_SUCH_MEMBER, requireAdminAndMember } from '../../member-route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const target = await requireAdminAndMember(request, params);
  if (target instanceof NextResponse) return target;

  const body = await parseJsonBody(request, setMemberDisabledRequestSchema, 'Invalid request.');
  if (body instanceof NextResponse) return body;

  const changed = await setMemberDisabled(getDb(), {
    userId: target.memberUserId,
    disabled: body.disabled,
  });
  if (!changed) return apiError('not_found', NO_SUCH_MEMBER);
  return apiOk({ disabled: body.disabled });
}
