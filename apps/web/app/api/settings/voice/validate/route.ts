// `POST /api/settings/voice/validate` — submit the stored source recording to
// the provider's voice validation. Server-to-server delivery only (the adapter
// uploads to the provider's temporary file service); may cost provider
// credits, so the task id is persisted the moment it exists and the profile
// flips to `validating_source` (refresh-on-read polls it to the phrase).

import { NextResponse } from 'next/server';
import { getVoiceRecording, markValidationSubmitted, withLockedVoiceProfile } from '@liedmotif/db';
import { ProviderError } from '@liedmotif/providers';
import { readAllBytes } from '@liedmotif/storage';
import { apiError, apiOk, requireAdminOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { ownVoiceEnabled } from '@/lib/env';
import { getStorageProvider } from '@/lib/providers/providers';
import { buildVoiceProfileView, musicVoiceApi } from '@/lib/voice/voice';

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
    if (!['draft', 'failed', 'awaiting_verification'].includes(profile.status)) {
      return apiError('conflict', 'A voice validation is not possible in the current state.');
    }
    const recording = await getVoiceRecording(tx, {
      ownerUserId,
      voiceProfileId: profile.id,
      kind: 'source',
    });
    if (!recording) return apiError('conflict', 'Record a source sample first.');
    // `vocalEndS` must describe the actual sample — without a measured duration
    // (only possible on a legacy row) the user re-records rather than the server
    // guessing a segment the provider would reject.
    if (recording.durationSeconds == null) {
      return apiError('conflict', 'Re-record the source sample first.');
    }

    const bytes = await readAllBytes(await getStorageProvider().readStream(recording.storageKey));
    let providerTaskId: string;
    try {
      ({ providerTaskId } = await voice.validateSource({
        audio: { bytes, mimeType: recording.mimeType, fileName: 'voice-source.wav' },
        // The whole (already duration-bounded) sample is the vocal segment.
        vocalStartS: 0,
        vocalEndS: Math.max(1, Math.round(recording.durationSeconds)),
        ...(profile.language ? { language: profile.language } : {}),
      }));
    } catch (error) {
      if (error instanceof ProviderError) {
        return apiError('provider_error', error.message, { retryable: true });
      }
      throw error;
    }

    const updated = await markValidationSubmitted(tx, { ownerUserId, providerTaskId });
    if (!updated) return apiError('conflict', 'The voice profile changed — reload and try again.');
    return updated;
  });
  if (!outcome) return apiError('conflict', 'Set up your voice profile first.');
  if (outcome instanceof Response) return outcome;
  return apiOk({ profile: await buildVoiceProfileView(db, outcome) });
}
