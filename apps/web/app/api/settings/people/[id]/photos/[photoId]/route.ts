import { NextResponse } from 'next/server';
import { deletePersonReferencePhoto } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { apiError, apiOk, requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { getStorageProvider } from '@/lib/providers/providers';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; photoId: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const { id: personId, photoId } = await context.params;
  if (!uuidSchema.safeParse(personId).success || !uuidSchema.safeParse(photoId).success) {
    return apiError('not_found', 'Reference photo not found.');
  }
  const deleted = await deletePersonReferencePhoto(getDb(), { ownerUserId, personId, photoId });
  if (!deleted) return apiError('not_found', 'Reference photo not found.');
  await getStorageProvider()
    .delete(deleted.storageKey)
    .catch(() => undefined);
  return apiOk({ deleted: true });
}
