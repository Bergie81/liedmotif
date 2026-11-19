// Profile avatar upload/removal. Each upload writes a freshly-keyed square WebP
// and repoints `user.image` at its opaque app URL; the previous object is queued
// for guaranteed deletion and deleted immediately as the fast path after the
// swap, so a stale URL simply 404s and a transient storage error never strands
// the bytes. Bytes are written before the user-record update and compensated on
// failure, mirroring the person-reference-photo route.

import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { getUserImage, queueOwnerStorageObjectDeletion } from '@liedmotif/db';
import { storageKeys } from '@liedmotif/storage';
import { apiError, apiOk, requireOwnerId } from '@/lib/http/api-response';
import { getAuth } from '@/lib/auth/auth';
import { avatarIdFromUrl, avatarUrlForId } from '@/lib/media/avatar';
import { processAvatarUpload } from '@/lib/media/avatar-image';
import { getDb } from '@/lib/db';
import {
  readImageUpload,
  readUploadForm,
  withImageUploadAdmission,
} from '@/lib/media/image-upload';
import { getStorageProvider } from '@/lib/providers/providers';

export const dynamic = 'force-dynamic';

/**
 * Repoint the signed-in user's `user.image` through Better Auth. Sessions are
 * served from a signed cookie cache (`session.cookieCache`), and only Better
 * Auth's own update path re-signs that cookie — a direct row write would leave
 * every render showing the previous avatar until the cache expires.
 */
async function updateSessionUserImage(imageUrl: string | null): Promise<void> {
  await getAuth().api.updateUser({
    body: { image: imageUrl },
    headers: await headers(),
  });
}

const AVATAR_DELETED_REASON = 'avatar_deleted';

/**
 * Remove the avatar bytes a `user.image` URL points at, once the URL is
 * repointed and the object unreferenced. The byte-delete is queued first (the
 * durable guarantee — an avatar is sensitive personal media that no orphan sweep
 * covers), then attempted immediately as the fast path; a successful immediate
 * delete simply makes the queued item a no-op.
 */
async function deleteAvatarObject(ownerUserId: string, imageUrl: string | null): Promise<void> {
  const avatarId = avatarIdFromUrl(imageUrl);
  if (!avatarId) return;
  const key = storageKeys.avatar(ownerUserId, avatarId, 'webp');
  await queueOwnerStorageObjectDeletion(getDb(), {
    ownerUserId,
    storageKey: key,
    reason: AVATAR_DELETED_REASON,
  });
  await getStorageProvider()
    .delete(key)
    .catch(() => undefined);
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return withImageUploadAdmission(ownerUserId, () => storeAvatar(request, ownerUserId));
}

async function storeAvatar(request: Request, ownerUserId: string): Promise<Response> {
  const form = await readUploadForm(request);
  if (form instanceof NextResponse) return form;
  const upload = await readImageUpload(form);
  if (upload instanceof NextResponse) return upload;
  const processed = await processAvatarUpload(upload.bytes);
  if (!processed) return apiError('validation_error', 'The file could not be read as an image.');

  const storage = getStorageProvider();
  // Read the URL to replace before writing anything, so a failing read aborts
  // the request instead of orphaning either avatar object.
  const previousImageUrl = await getUserImage(getDb(), ownerUserId);
  const avatarId = randomUUID();
  const storageKey = storageKeys.avatar(ownerUserId, avatarId, 'webp');
  // Nothing is recorded against the quota: an avatar is one per user, replaced
  // rather than accumulated, and is the documented exclusion from the measured
  // total — what admission bounds here is uploading INTO a full instance.
  await storage.write({ key: storageKey, body: processed.bytes, mimeType: processed.mediaType });

  const imageUrl = avatarUrlForId(avatarId);
  try {
    await updateSessionUserImage(imageUrl);
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
  await deleteAvatarObject(ownerUserId, previousImageUrl);
  return apiOk({ imageUrl });
}

export async function DELETE(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const previousImageUrl = await getUserImage(getDb(), ownerUserId);
  await updateSessionUserImage(null);
  await deleteAvatarObject(ownerUserId, previousImageUrl);
  return apiOk({ imageUrl: null });
}
