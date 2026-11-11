// `POST /api/settings/voice/verify` — submit the recorded verification phrase
// to create the provider voice. Mirrors the validate route: server-to-server
// delivery, task id persisted immediately, profile flips to `creating_voice`
// (refresh-on-read polls it to `ready`).

import { NextResponse } from 'next/server';
import {
  getVoiceRecording,
  markVoiceCreationSubmitted,
  withLockedVoiceProfile,
} from '@liedmotif/db';
import { ProviderError } from '@liedmotif/providers';
import { readAllBytes } from '@liedmotif/storage';
import { apiError, apiOk, requireAdminOwnerId } from '@/lib/api-response';
import { getDb } from '@/lib/db';
import { ownVoiceEnabled } from '@/lib/env';
import { getStorageProvider } from '@/lib/providers';
import { buildVoiceProfileView, musicVoiceApi } from '@/lib/voice';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireAdminOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  if (!ownVoiceEnabled()) return apiError('not_found', 'Not found.');
  const voice = await musicVoiceApi();
  if (!voice) {
    return apiError(
      'validation_error',
      'The configured music provider does not support voice profiles.',
    );
  }

  const db = getDb();
  const outcome = await withLockedVoiceProfile(db, ownerUserId, async (tx, profile) => {
    if (!['awaiting_verification', 'failed'].includes(profile.status)) {
      return apiError('conflict', 'Voice creation is not possible in the current state.');
    }
    // A failed VALIDATION also lands in `failed` — creation retries are only
    // legal once a phrase was issued for the current validation task.
    const validationTaskId = profile.providerValidationTaskId;
    if (!validationTaskId || !profile.verificationPhrase) {
      return apiError('conflict', 'Validate a source sample first.');
    }
    const recording = await getVoiceRecording(tx, {
      ownerUserId,
      voiceProfileId: profile.id,
      kind: 'verification',
    });
    if (!recording) return apiError('conflict', 'Record the verification phrase first.');

    const bytes = await readAllBytes(await getStorageProvider().readStream(recording.storageKey));
    let providerTaskId: string;
    try {
      ({ providerTaskId } = await voice.createVoice({
        validationTaskId,
        audio: { bytes, mimeType: recording.mimeType, fileName: 'voice-verification.wav' },
      }));
    } catch (error) {
      if (error instanceof ProviderError) {
        return apiError('provider_error', error.message, { retryable: true });
      }
      throw error;
    }

    const updated = await markVoiceCreationSubmitted(tx, { ownerUserId, providerTaskId });
    if (!updated) return apiError('conflict', 'The voice profile changed — reload and try again.');
    return updated;
  });
  if (!outcome) return apiError('conflict', 'Set up your voice profile first.');
  if (outcome instanceof Response) return outcome;
  return apiOk({ profile: await buildVoiceProfileView(db, outcome) });
}
