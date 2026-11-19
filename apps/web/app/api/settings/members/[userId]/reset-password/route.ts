// Admin-only: reset a Member's password through a one-shot link. The Admin
// never sets or sees a password. With account email on, the link is mailed to
// the Member's Confirmed email and never comes back here; otherwise the Admin
// gets the 24-hour link to copy, with the reason it was not mailed. A Disabled
// account is never mailed, and an unconfirmed address may be a typo that
// belongs to someone else.

import { eq } from 'drizzle-orm';
import {
  createPasswordResetLink,
  getConfirmedEmail,
  resolveUserProfile,
  user,
  type Database,
} from '@liedmotif/db';
import type { MemberResetFallbackReason, MemberResetPasswordResponse } from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { mailPasswordResetLink } from '@/lib/auth/account-mail';
import { apiOk } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { resetLinkUrl } from '@/lib/auth/link-urls';
import { requireAdminAndMember, type MemberRouteTarget } from '../../member-route';

export const dynamic = 'force-dynamic';

/** The address the reset mail went to, or why it was not mailed. */
async function mailResetLink(
  db: Database,
  { adminUserId, memberUserId }: MemberRouteTarget,
): Promise<{ to: string } | { reason: MemberResetFallbackReason }> {
  if (!isAccountEmailEnabled()) return { reason: 'email_off' };
  const profile = await resolveUserProfile(db, memberUserId);
  if (profile?.disabledAt) return { reason: 'disabled' };
  const to = await getConfirmedEmail(db, memberUserId);
  if (!to) return { reason: 'unconfirmed' };
  const sent = await mailPasswordResetLink(db, {
    userId: memberUserId,
    email: to,
    createdByUserId: adminUserId,
  });
  return sent ? { to } : { reason: 'send_failed' };
}

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const target = await requireAdminAndMember(request, params);
  if (target instanceof NextResponse) return target;

  const db = getDb();
  const mail = await mailResetLink(db, target);
  if ('to' in mail) return apiOk<MemberResetPasswordResponse>({ sent: true, to: mail.to });

  const [account] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, target.memberUserId));
  const { token } = await createPasswordResetLink(db, {
    targetUserId: target.memberUserId,
    label: account?.name?.trim() || 'Member',
    createdByUserId: target.adminUserId,
  });
  return apiOk<MemberResetPasswordResponse>({ url: resetLinkUrl(token), reason: mail.reason });
}
