// Serves avatar bytes to any signed-in User. The storage key is rebuilt from
// the id of the user whose `image` currently references this avatarId — an
// avatar is identity chrome, shown wherever its owner is attributed (account
// menu, Lounge shares), so in-instance readability is the point.
// Ownership of the BYTES stays enforced by construction: only the referencing
// user's key is ever read, and a replaced avatarId references nobody, so old
// URLs go dark the moment the owner swaps or removes their picture.

import { NextResponse } from 'next/server';
import { getAvatarOwnerUserId } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { storageKeys } from '@liedmotif/storage';
import { requireOwnerId } from '@/lib/api-response';
import { avatarUrlForId } from '@/lib/avatar';
import { getDb } from '@/lib/db';
import { privateBytesResponse } from '@/lib/private-bytes';
import { getStorageProvider } from '@/lib/providers';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(request: Request, { params }: { params: Promise<{ avatarId: string }> }) {
  const viewerUserId = await requireOwnerId(request);
  if (viewerUserId instanceof NextResponse) return viewerUserId;
  const { avatarId } = await params;
  if (!uuidSchema.safeParse(avatarId).success) return notFound();

  const ownerUserId = await getAvatarOwnerUserId(getDb(), avatarUrlForId(avatarId));
  if (!ownerUserId) return notFound();

  const storage = getStorageProvider();
  const storageKey = storageKeys.avatar(ownerUserId, avatarId, 'webp');
  const stat = await storage.stat(storageKey);
  if (!stat) return notFound();
  let stream;
  try {
    stream = await storage.readStream(storageKey);
  } catch {
    // A concurrent replace can delete the object between stat and read.
    return notFound();
  }
  return privateBytesResponse({
    body: stream,
    contentType: 'image/webp',
    byteSize: stat.byteSize,
    // A fresh avatarId per upload makes each URL immutable — safe to cache.
    cache: 'immutable',
  });
}
