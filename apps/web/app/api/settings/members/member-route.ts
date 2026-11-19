// The opening two lines every `/settings/members/[userId]` route shares: the
// admin gate, plus proof that the id names a MEMBER.
//
// One refusal for both (`NO_SUCH_MEMBER`) on purpose: collapsing "no such user"
// and "that user is the Admin" into one answer keeps the routes from each
// inventing their own wording for the same fact. There is deliberately no shape
// check on the id — `user.id` is free-form text (Better Auth mints its own
// format, the invite claim mints a uuid), so the only meaningful validation is
// whether it resolves to a Member profile, which is exactly what this does. The
// repo-level `role='member'` predicates stay where they are: this is the gate,
// not a replacement for defence in depth.

import { resolveUserProfile } from '@liedmotif/db';
import { NextResponse } from 'next/server';
import { apiError, requireAdminOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';

export const NO_SUCH_MEMBER = 'No such member.';

export interface MemberRouteTarget {
  /** The signed-in Admin performing the change. */
  adminUserId: string;
  /** The Member the route acts on. */
  memberUserId: string;
}

export async function requireAdminAndMember(
  request: Request,
  params: Promise<{ userId: string }>,
): Promise<MemberRouteTarget | NextResponse> {
  const adminUserId = await requireAdminOwnerId(request);
  if (adminUserId instanceof NextResponse) return adminUserId;

  const { userId } = await params;
  const profile = await resolveUserProfile(getDb(), userId);
  if (profile?.role !== 'member') return apiError('not_found', NO_SUCH_MEMBER);

  return { adminUserId, memberUserId: userId };
}
