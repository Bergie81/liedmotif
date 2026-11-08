import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  insertPersonReferencePhoto,
  listPersonReferencePhotos,
  MAX_OWNER_PERSON_REFERENCE_PHOTOS,
  MAX_PERSON_REFERENCE_PHOTOS,
} from '@liedmotif/db';
import { uuidSchema } from '@liedmotif/shared';
import { storageKeys } from '@liedmotif/storage';
import { apiError, apiOk, requireOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { readImageUpload, readUploadForm, withImageUploadAdmission } from '@/lib/image-upload';
import { toPersonReferencePhotoSummary } from '@/lib/person-reference-photos';
import { getStorageProvider } from '@/lib/providers';
import { processCoverReferenceUpload } from '@/lib/reference-images';
import type { RecordStoredBytes } from '@/lib/storage-quota';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const { id: personId } = await context.params;
  if (!uuidSchema.safeParse(personId).success) {
    return apiError('not_found', 'Person not found.');
  }
  const db = getDb();
  const [personPhotos, allPhotos] = await Promise.all([
    listPersonReferencePhotos(db, { ownerUserId, personId }),
    listPersonReferencePhotos(db, { ownerUserId }),
  ]);
  return apiOk({
    items: personPhotos.map(toPersonReferencePhotoSummary),
    personCount: personPhotos.length,
    totalCount: allPhotos.length,
    maxPerPerson: MAX_PERSON_REFERENCE_PHOTOS,
    maxTotal: MAX_OWNER_PERSON_REFERENCE_PHOTOS,
  });
}

export async function POST(request: Request, context: RouteContext) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const { id: personId } = await context.params;
  if (!uuidSchema.safeParse(personId).success) {
    return apiError('not_found', 'Person not found.');
  }
  return withImageUploadAdmission(ownerUserId, (recordStored) =>
    storePhoto(request, ownerUserId, personId, recordStored),
  );
}

async function storePhoto(
  request: Request,
  ownerUserId: string,
  personId: string,
  recordStored: RecordStoredBytes,
): Promise<Response> {
  const form = await readUploadForm(request);
  if (form instanceof NextResponse) return form;
  const upload = await readImageUpload(form);
  if (upload instanceof NextResponse) return upload;
  const processed = await processCoverReferenceUpload(upload.bytes);
  if (!processed) return apiError('validation_error', 'The file could not be read as an image.');

  const db = getDb();
  const storage = getStorageProvider();
  const photoId = randomUUID();
  const storageKey = storageKeys.personReferencePhoto(ownerUserId, personId, photoId, 'webp');
  const stat = await storage.write({
    key: storageKey,
    body: processed.bytes,
    mimeType: processed.mediaType,
  });
  let result;
  try {
    result = await insertPersonReferencePhoto(db, {
      id: photoId,
      ownerUserId,
      personId,
      storageProvider: storage.providerKey,
      storageKey,
      mediaType: processed.mediaType,
      originalFilename: upload.filename || null,
      byteSize: stat.byteSize,
      width: processed.width,
      height: processed.height,
    });
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
  if (!result.inserted) {
    await storage.delete(storageKey).catch(() => undefined);
    if (result.reason === 'person_not_found') {
      return apiError('not_found', 'Person not found.');
    }
    if (result.reason === 'person_limit_reached') {
      return apiError(
        'conflict',
        `This Person already has ${MAX_PERSON_REFERENCE_PHOTOS} reference photos.`,
      );
    }
    return apiError(
      'conflict',
      `You already have ${MAX_OWNER_PERSON_REFERENCE_PHOTOS} Person reference photos.`,
    );
  }
  // Only a photo that kept its bytes counts: every refusal above deletes them.
  recordStored(stat.byteSize);
  return apiOk({ photo: toPersonReferencePhotoSummary(result.photo) });
}
