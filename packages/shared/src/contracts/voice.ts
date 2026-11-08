// Settings -> My voice contracts: the safe profile view the UI polls, the
// mutation requests, and the recording constraints both sides enforce. The
// view NEVER carries provider task/voice ids, provider URLs, or storage keys —
// status, phrase, and safe messages are all the browser needs.

import { z } from 'zod';
import { apiResponse } from './common';

/** Provider language hints the voice-validation endpoint documents. */
export const VOICE_LANGUAGES = [
  'en',
  'zh',
  'es',
  'fr',
  'pt',
  'de',
  'ja',
  'ko',
  'hi',
  'ru',
] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/** The UI-facing profile lifecycle; 'none' means no profile exists yet. */
export const VOICE_PROFILE_VIEW_STATUSES = [
  'none',
  'draft',
  'validating_source',
  'awaiting_verification',
  'creating_voice',
  'ready',
  'failed',
  'disabled',
] as const;
export type VoiceProfileViewStatus = (typeof VOICE_PROFILE_VIEW_STATUSES)[number];

export const VOICE_RECORDING_KINDS = ['source', 'verification'] as const;
export type VoiceRecordingKindValue = (typeof VOICE_RECORDING_KINDS)[number];

// Recording bounds (client gates before upload; the server re-checks size/MIME).
// The provider re-validates the audio itself, so durations are guidance-level.
export const VOICE_SOURCE_MIN_SECONDS = 10;
export const VOICE_SOURCE_MAX_SECONDS = 120;
export const VOICE_VERIFICATION_MIN_SECONDS = 3;
export const VOICE_VERIFICATION_MAX_SECONDS = 60;
/** 120s of 16-bit 48kHz mono WAV is ~11.5MB; the cap leaves generous headroom. */
export const MAX_VOICE_RECORDING_UPLOAD_BYTES = 32 * 1024 * 1024;

export const voiceProfileViewSchema = z.strictObject({
  status: z.enum(VOICE_PROFILE_VIEW_STATUSES),
  displayName: z.string(),
  /** Provider language hint ('' = let the provider decide). */
  language: z.string(),
  /** The provider phrase to record; non-null once awaiting verification. */
  verificationPhrase: z.string().nullable(),
  errorMessageSafe: z.string().nullable(),
  hasSourceRecording: z.boolean(),
  hasVerificationRecording: z.boolean(),
  /** The configured music provider offers voice-profile setup at all. */
  setupSupported: z.boolean(),
  /** The configured music model can GENERATE with a custom voice. */
  generationSupported: z.boolean(),
  /** Ready + generation-supported: whether "Use my voice" can be offered NOW. */
  availableForSessions: z.boolean(),
});
export type VoiceProfileView = z.infer<typeof voiceProfileViewSchema>;

/** Every voice-profile endpoint answers with the same safe view envelope. */
export const voiceProfileResponseSchema = apiResponse(
  z.strictObject({ profile: voiceProfileViewSchema }),
);
export type VoiceProfileResponse = z.infer<typeof voiceProfileResponseSchema>;

export const createVoiceProfileRequestSchema = z.strictObject({
  /** The consent notice must be accepted; the profile row records it. */
  consent: z.literal(true),
  language: z.enum(VOICE_LANGUAGES).optional(),
});
export type CreateVoiceProfileRequest = z.infer<typeof createVoiceProfileRequestSchema>;

export const updateVoiceProfileRequestSchema = z.strictObject({
  enabled: z.boolean(),
});
export type UpdateVoiceProfileRequest = z.infer<typeof updateVoiceProfileRequestSchema>;

/** Client-measured recording metadata riding the multipart upload. */
export const voiceRecordingUploadFieldsSchema = z.strictObject({
  kind: z.enum(VOICE_RECORDING_KINDS),
  // The documented recording bound: the longest take any kind offers is the
  // source maximum, and the client refuses to save past it.
  durationSeconds: z.coerce.number().positive().max(VOICE_SOURCE_MAX_SECONDS),
  peakDbfs: z.coerce.number().max(0).optional(),
  loudnessLufs: z.coerce.number().max(0).optional(),
});
export type VoiceRecordingUploadFields = z.infer<typeof voiceRecordingUploadFieldsSchema>;
