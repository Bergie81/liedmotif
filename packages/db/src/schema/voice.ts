// User voice profiles (Settings -> My voice): one custom voice per User, plus
// the recordings behind it. Voice recordings are sensitive personal data — the
// rows carry storage references only, never audio bytes or provider URLs, and
// the provider task/voice ids stay server-side (the UI reads status + phrase).

import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';
import { voiceProfileStatus, voiceRecordingKind } from './enums';

/** How a recording was captured/cleaned (browser constraint flags + metrics). */
export interface VoiceCaptureSettings {
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  [key: string]: unknown;
}

/**
 * The one voice profile a User may own (unique on `owner_user_id`; deletion is
 * a hard delete plus storage cleanup, so no tombstone state exists here).
 */
export const voiceProfiles = pgTable(
  'voice_profiles',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    displayName: text('display_name').notNull().default('My voice'),
    status: voiceProfileStatus('status').notNull().default('draft'),
    /** The music provider the profile was created against (open vocab, like
     *  `generation_requests.provider_key`). */
    providerKey: text('provider_key').notNull(),
    providerValidationTaskId: text('provider_validation_task_id'),
    providerVoiceTaskId: text('provider_voice_task_id'),
    /** The provider voice reference used for generation; set once `ready`. */
    providerVoiceId: text('provider_voice_id'),
    /** The provider-issued phrase the user must record to verify the voice. */
    verificationPhrase: text('verification_phrase'),
    /** Provider language hint for validation (e.g. 'en'); null lets it decide. */
    language: text('language'),
    consentVersion: text('consent_version').notNull(),
    consentAcceptedAt: timestamp('consent_accepted_at', { withTimezone: true }).notNull(),
    errorCode: text('error_code'),
    errorMessageSafe: text('error_message_safe'),
    /** Last provider status poll — the refresh-on-read throttle reference. */
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('voice_profiles_owner_user_id_unique').on(table.ownerUserId)],
);

/** One stored recording per (profile, kind); re-recording replaces the row. */
export const voiceRecordings = pgTable(
  'voice_recordings',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    voiceProfileId: uuid('voice_profile_id')
      .notNull()
      .references(() => voiceProfiles.id, { onDelete: 'cascade' }),
    kind: voiceRecordingKind('kind').notNull(),
    storageProvider: text('storage_provider').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** Client-measured metadata (advisory; the provider re-validates the audio). */
    durationSeconds: doublePrecision('duration_seconds'),
    peakDbfs: doublePrecision('peak_dbfs'),
    loudnessLufs: doublePrecision('loudness_lufs'),
    captureSettings: jsonb('capture_settings').$type<VoiceCaptureSettings>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('voice_recordings_profile_kind_unique').on(table.voiceProfileId, table.kind),
    uniqueIndex('voice_recordings_storage_key_unique').on(table.storageKey),
    // RI cascade probe on user delete.
    index('voice_recordings_owner_idx').on(table.ownerUserId),
  ],
);
