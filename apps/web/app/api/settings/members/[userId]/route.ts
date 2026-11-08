// Admin-only: delete a Member. Destructive and permanent — the
// typed confirmation lives in the UI; this route owns correctness. The avatar
// storage key is derived here (it has no column) and handed to the repo, which
// enqueues every key BEFORE letting the FK cascade run.

import { eq } from 'drizzle-orm';
import { deleteMember, user } from '@liedmotif/db';
import { storageKeys } from '@liedmotif/storage';
import { NextResponse } from 'next/server';
import { apiError, apiOk } from '@/lib/api-response';
import { avatarIdFromUrl } from '@/lib/avatar';
import { getDb } from '@/lib/db';
import { NO_SUCH_MEMBER, requireAdminAndMember } from '../member-route';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const target = await requireAdminAndMember(request, params);
  if (target instanceof NextResponse) return target;
  const { memberUserId } = target;

  const db = getDb();
  const [account] = await db
    .select({ image: user.image })
    .from(user)
    .where(eq(user.id, memberUserId));
  const avatarId = avatarIdFromUrl(account?.image ?? null);
  const result = await deleteMember(db, {
    userId: memberUserId,
    avatarStorageKey: avatarId ? storageKeys.avatar(memberUserId, avatarId, 'webp') : null,
  });
  if (!result.ok) return apiError('not_found', NO_SUCH_MEMBER);
  return apiOk({ deleted: true, trackCount: result.trackCount });
}
