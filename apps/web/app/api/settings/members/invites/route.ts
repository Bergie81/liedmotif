// Admin-only: mint a Member invite; the row keeps just the token's hash. With
// account email off, the response carries the full claim URL — the only time
// the plaintext token exists outside the Admin's clipboard. With it on, the
// Invite is bound to an address and its link goes only into the mail.

import { createMemberInvite, findUserByEmail, listOpenMemberInvites } from '@liedmotif/db';
import {
  createMemberInviteRequestSchema,
  DEFAULT_MEMBER_LIMITS,
  foreignKindFields,
  memberLimitsSchema,
} from '@liedmotif/shared';
import { NextResponse } from 'next/server';
import { mailMemberInvite } from '@/lib/auth/account-mail';
import { apiError, apiOk, parseJsonBody, requireAdminOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { joinLinkUrl } from '@/lib/auth/link-urls';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return apiOk({ invites: await listOpenMemberInvites(getDb()) });
}

export async function POST(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await parseJsonBody(request, createMemberInviteRequestSchema, 'Invalid invite.');
  if (body instanceof NextResponse) return body;
  const byEmail = isAccountEmailEnabled();
  if (byEmail && !body.email) {
    return apiError('validation_error', 'Enter the email address to send the invite to.');
  }
  if (!byEmail && body.email !== undefined) {
    return apiError('validation_error', 'Invites go by link while account email is off.');
  }

  // The starting budget is snapshotted whole onto the invite: defaults under
  // the patch, cross-field rules on the merged object. A One-time snapshot's
  // Grant is a placeholder — the claim re-stamps it to the claim time.
  const kind = body.budget?.kind ?? DEFAULT_MEMBER_LIMITS.kind;
  const foreign = foreignKindFields(kind, body.budget ?? {});
  if (foreign.length > 0) {
    return apiError('validation_error', `Not a ${kind} budget field: ${foreign.join(', ')}.`);
  }
  const budget = memberLimitsSchema.safeParse({
    ...DEFAULT_MEMBER_LIMITS,
    ...body.budget,
    ...(kind === 'oneTime' ? { grantedAt: new Date().toISOString() } : {}),
  });
  if (!budget.success) {
    return apiError('validation_error', 'Invalid invite budget.', {
      details: budget.error.flatten(),
    });
  }

  const db = getDb();
  if (body.email) {
    const email = body.email.toLowerCase();
    if (await findUserByEmail(db, email)) {
      return apiError('conflict', 'Someone already signs in with that email.');
    }
    if ((await listOpenMemberInvites(db)).some((open) => open.email === email)) {
      return apiError('conflict', 'An open invite was already sent to that email.');
    }
    const invite = await mailMemberInvite(db, {
      label: body.label,
      email,
      budget: budget.data,
      createdByUserId: ownerUserId,
    });
    if (!invite) {
      return apiError('provider_error', 'The invite could not be sent. Try again later.', {
        retryable: true,
      });
    }
    return apiOk({
      invite: {
        id: invite.id,
        label: invite.label,
        email: invite.email,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      },
    });
  }

  const { invite, token } = await createMemberInvite(db, {
    label: body.label,
    budget: budget.data,
    createdByUserId: ownerUserId,
  });
  return apiOk({
    url: joinLinkUrl(token),
    invite: {
      id: invite.id,
      label: invite.label,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    },
  });
}
