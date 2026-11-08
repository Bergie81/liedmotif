// POST /api/sessions/cover/upload — put the owner's own image into a Session's
// cover history. No provider call and no spend: an upload costs nothing and
// consumes no generation limit. It is otherwise an ordinary history entry —
// previewed before it is saved (the swap goes through `select`), re-selectable
// later, and deletable — so it occupies one of the session's
// MAX_SESSION_COVER_HISTORY slots.

import { NextResponse } from 'next/server';
import { addUploadedSessionCover, countSessionCoverHistory, getSessionById } from '@liedmotif/db';
import { MAX_SESSION_COVER_HISTORY, uuidSchema } from '@liedmotif/shared';
import { apiError, apiOk, requireOwnerId } from '@/lib/api-response';
import { processCoverUpload, storeUploadedCover } from '@/lib/cover-upload-image';
import { getDb } from '@/lib/db';
import { readImageUpload, readUploadForm, withImageUploadAdmission } from '@/lib/image-upload';
import type { RecordStoredBytes } from '@/lib/storage-quota';

export const dynamic = 'force-dynamic';

const SESSION_FULL_MESSAGE = `This Session already keeps ${MAX_SESSION_COVER_HISTORY} covers. Delete a previous cover to upload another one.`;

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return withImageUploadAdmission(ownerUserId, (recordStored) =>
    storeSessionCover(request, ownerUserId, recordStored),
  );
}

async function storeSessionCover(
  request: Request,
  ownerUserId: string,
  recordStored: RecordStoredBytes,
): Promise<Response> {
  const form = await readUploadForm(request);
  if (form instanceof NextResponse) return form;
  const activitySessionId = uuidSchema.safeParse(form.get('activitySessionId'));
  if (!activitySessionId.success) {
    return apiError('validation_error', 'An activitySessionId form field is required.');
  }
  const upload = await readImageUpload(form);
  if (upload instanceof NextResponse) return upload;

  const db = getDb();
  const session = await getSessionById(db, { ownerUserId, sessionId: activitySessionId.data });
  if (!session) return apiError('not_found', 'Session not found.');
  // Wasted-work guard only; the registration re-checks under the owner lock.
  const kept = await countSessionCoverHistory(db, {
    ownerUserId,
    activitySessionId: session.id,
  });
  if (kept >= MAX_SESSION_COVER_HISTORY) {
    return apiError('limit_reached', SESSION_FULL_MESSAGE);
  }

  const processed = await processCoverUpload(upload.bytes);
  if (!processed) return apiError('validation_error', 'The file could not be read as an image.');

  const coverImageId = await storeUploadedCover({
    ownerUserId,
    processed,
    recordStored,
    register: async (cover) =>
      (await addUploadedSessionCover(db, {
        ownerUserId,
        activitySessionId: session.id,
        maxHistory: MAX_SESSION_COVER_HISTORY,
        ...cover,
      })) === 'added',
  });
  if (!coverImageId) return apiError('limit_reached', SESSION_FULL_MESSAGE);
  return apiOk({ coverImageId });
}
