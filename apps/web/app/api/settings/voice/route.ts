// Settings -> My voice profile resource.
//   GET    → the safe profile view; refreshes in-flight provider tasks
//            (throttled refresh-on-read — the UI polls this while waiting).
//   POST   → create the profile (records consent; idempotent).
//   PATCH  → disable / re-enable a ready profile.
//   DELETE → hard-delete the profile and its stored recordings.
// Provider task ids, voice ids, and storage keys never leave the server.

import { NextResponse } from 'next/server';
import {
  createVoiceProfile,
  deleteVoiceProfile,
  getVoiceProfile,
  setVoiceProfileEnabled,
} from '@liedmotif/db';
import {
  createVoiceProfileRequestSchema,
  updateVoiceProfileRequestSchema,
} from '@liedmotif/shared';
import { apiError, apiOk, parseJsonBody, requireAdminOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { ownVoiceEnabled } from '@/lib/env';
import { getMusicProvider, getStorageProvider } from '@/lib/providers/providers';
import {
  buildVoiceProfileView,
  musicVoiceApi,
  refreshVoiceProfile,
  VOICE_CONSENT_VERSION,
} from '@/lib/voice/voice';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!ownVoiceEnabled()) return apiError('not_found', 'Not found.');
  const db = getDb();
  let profile = await getVoiceProfile(db, ownerUserId);
  if (profile) profile = await refreshVoiceProfile(db, profile);
  return apiOk({ profile: await buildVoiceProfileView(db, profile) });
}

export async function POST(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!ownVoiceEnabled()) return apiError('not_found', 'Not found.');
  const parsed = await parseJsonBody(
    request,
    createVoiceProfileRequestSchema,
    'Invalid voice profile request.',
  );
  if (parsed instanceof NextResponse) return parsed;
  if ((await musicVoiceApi()) === null) {
    return apiError(
      'validation_error',
      'The configured music provider does not support voice profiles.',
    );
  }

  const db = getDb();
  const profile = await createVoiceProfile(db, {
    ownerUserId,
    providerKey: (await getMusicProvider()).providerKey,
    consentVersion: VOICE_CONSENT_VERSION,
    language: parsed.language ?? null,
  });
  return apiOk({ profile: await buildVoiceProfileView(db, profile) });
}

export async function PATCH(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!ownVoiceEnabled()) return apiError('not_found', 'Not found.');
  const parsed = await parseJsonBody(
    request,
    updateVoiceProfileRequestSchema,
    'Invalid voice profile request.',
  );
  if (parsed instanceof NextResponse) return parsed;

  const db = getDb();
  const updated = await setVoiceProfileEnabled(db, { ownerUserId, enabled: parsed.enabled });
  if (!updated) {
    return apiError(
      'conflict',
      parsed.enabled
        ? 'Only a disabled voice profile can be re-enabled.'
        : 'Only a ready voice profile can be disabled.',
    );
  }
  return apiOk({ profile: await buildVoiceProfileView(db, updated) });
}

export async function DELETE(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!ownVoiceEnabled()) return apiError('not_found', 'Not found.');
  const db = getDb();
  const { storageKeys: orphanedKeys } = await deleteVoiceProfile(db, ownerUserId);
  // Recording objects are deleted AFTER the rows are gone — best-effort, so a
  // storage hiccup never resurrects the profile (the keys are unreachable
  // either way; local-fs cleanup can be re-run by deleting the directory).
  const storage = getStorageProvider();
  await Promise.all(orphanedKeys.map((key) => storage.delete(key).catch(() => undefined)));
  return apiOk({ profile: await buildVoiceProfileView(db, null) });
}
