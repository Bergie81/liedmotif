// `POST /api/settings/voice/recordings` — store one voice recording (multipart:
// the WAV file plus client-measured metadata). One recording per kind; a
// re-record replaces the previous one and its bytes. Recordings are sensitive
// personal data: bytes go to Liedmotif storage only, and nothing here reaches a
// provider until the user explicitly submits a workflow step.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getVoiceProfile, replaceVoiceRecording } from '@liedmotif/db';
import {
  MAX_VOICE_RECORDING_UPLOAD_BYTES,
  voiceRecordingUploadFieldsSchema,
} from '@liedmotif/shared';
import { storageKeys } from '@liedmotif/storage';
import {
  apiError,
  apiOk,
  MULTIPART_OVERHEAD_BYTES,
  refuseOversizedBody,
  requireAdminOwnerId,
  validateInput,
} from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { ownVoiceEnabled } from '@/lib/env';
import { getStorageProvider } from '@/lib/providers/providers';
import { withUploadAdmission } from '@/lib/http/request-admission';
import { withStorageAdmission, type RecordStoredBytes } from '@/lib/media/storage-quota';
import { buildVoiceProfileView } from '@/lib/voice/voice';

export const dynamic = 'force-dynamic';

/** The client always uploads WAV (it re-encodes the capture); accept both names. */
const WAV_MIME_ALLOWLIST = ['audio/wav', 'audio/x-wav', 'audio/wave'];

const TOO_LARGE_MESSAGE = `The recording is too large (${Math.round(MAX_VOICE_RECORDING_UPLOAD_BYTES / (1024 * 1024))} MB max).`;

/**
 * Whether the bytes open as a RIFF/WAVE container. The declared MIME above is
 * the client's label; these bytes are stored as sensitive personal media and
 * later forwarded to the voice provider, so what they actually are is worth the
 * twelve-byte read.
 */
function isWavContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

export async function POST(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!ownVoiceEnabled()) return apiError('not_found', 'Not found.');
  return withUploadAdmission(ownerUserId, () =>
    // Recordings are the fattest thing the app stores per request; the quota and
    // the volume are asked for room before the body is buffered.
    withStorageAdmission(ownerUserId, MAX_VOICE_RECORDING_UPLOAD_BYTES, (recordStored) =>
      storeRecording(request, ownerUserId, recordStored),
    ),
  );
}

async function storeRecording(
  request: Request,
  ownerUserId: string,
  recordStored: RecordStoredBytes,
): Promise<Response> {
  // WAV is the fattest body the app accepts, and `formData()` buffers it whole:
  // the declared-size gate has to precede the parse, not the `file.size` cap.
  const oversized = refuseOversizedBody(request, {
    maxBytes: MAX_VOICE_RECORDING_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
    tooLargeMessage: TOO_LARGE_MESSAGE,
  });
  if (oversized) return oversized;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiError('validation_error', 'Expected a multipart form upload.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) return apiError('validation_error', 'Attach a recording.');
  if (!WAV_MIME_ALLOWLIST.includes(file.type)) {
    return apiError('validation_error', 'Use a WAV recording.');
  }
  if (file.size === 0) return apiError('validation_error', 'The recording is empty.');
  if (file.size > MAX_VOICE_RECORDING_UPLOAD_BYTES) {
    return apiError('validation_error', TOO_LARGE_MESSAGE);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isWavContainer(bytes)) return apiError('validation_error', 'Use a WAV recording.');
  const fields = validateInput(
    voiceRecordingUploadFieldsSchema,
    {
      kind: form.get('kind'),
      durationSeconds: form.get('durationSeconds'),
      ...(form.get('peakDbfs') !== null ? { peakDbfs: form.get('peakDbfs') } : {}),
      ...(form.get('loudnessLufs') !== null ? { loudnessLufs: form.get('loudnessLufs') } : {}),
    },
    'Invalid recording metadata.',
  );
  if (fields instanceof NextResponse) return fields;

  const db = getDb();
  const profile = await getVoiceProfile(db, ownerUserId);
  if (!profile) return apiError('conflict', 'Set up your voice profile first.');

  // Bytes land in storage BEFORE the row flips (write-then-record, like the
  // avatar route); a failed row write leaves an orphan object we delete again.
  const storage = getStorageProvider();
  const storageKey = storageKeys.voiceRecording(ownerUserId, randomUUID(), 'wav');
  await storage.write({ key: storageKey, body: bytes, mimeType: 'audio/wav' });

  let replacedStorageKey: string | null;
  try {
    ({ replacedStorageKey } = await replaceVoiceRecording(db, {
      ownerUserId,
      voiceProfileId: profile.id,
      kind: fields.kind,
      storageProvider: storage.providerKey,
      storageKey,
      mimeType: 'audio/wav',
      byteSize: file.size,
      durationSeconds: fields.durationSeconds,
      peakDbfs: fields.peakDbfs ?? null,
      loudnessLufs: fields.loudnessLufs ?? null,
    }));
  } catch (error) {
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
  if (replacedStorageKey) await storage.delete(replacedStorageKey).catch(() => undefined);
  // The replaced recording's bytes are not discounted here: the quota may read
  // high until the next measurement, which is the safe direction to be wrong in.
  recordStored(bytes.byteLength);

  return apiOk({ profile: await buildVoiceProfileView(db, profile) });
}
