import { NextResponse } from 'next/server';
import { getPersonReferencePhoto } from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { requireOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { privateBytesResponse } from '@/lib/private-bytes';
import { getStorageProvider } from '@/lib/providers';

export const dynamic = 'force-dynamic';

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const { id: personId, photoId } = await params;
  if (!uuidSchema.safeParse(personId).success || !uuidSchema.safeParse(photoId).success) {
    return notFound();
  }
  const photo = await getPersonReferencePhoto(getDb(), { ownerUserId, photoId });
  if (!photo || photo.personId !== personId) return notFound();
  const storage = getStorageProvider();
  const stat = await storage.stat(photo.storageKey);
  if (!stat) return notFound();
  const stream = await storage.readStream(photo.storageKey);
  return privateBytesResponse({
    body: stream,
    contentType: photo.mediaType,
    byteSize: stat.byteSize,
    cache: 'immutable',
  });
}
