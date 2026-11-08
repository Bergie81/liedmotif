// Voice-profile repository (Settings -> My voice). Every read/write is scoped
// to the owning user; the "one profile per User" rule is enforced by the
// `voice_profiles_owner_user_id_unique` index, and state transitions are
// guarded (`WHERE status = ...`) so a stale request or racing poll can never
// clobber a later state.

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { queueStorageObjectDeletion } from '../generation/deletion-queue-repo';
import { voiceProfiles, voiceRecordings, type VoiceCaptureSettings } from '../schema';
import { withTransaction, type DbOrTx } from '../transactions';

/**
 * Recording bytes are sensitive personal media; a replaced or deleted recording
 * queues its object for guaranteed reclaim, so a transient storage-delete
 * failure can never strand it.
 */
export const VOICE_RECORDING_DELETED_REASON = 'voice_recording_deleted';

export type VoiceProfileRow = typeof voiceProfiles.$inferSelect;
export type VoiceRecordingRow = typeof voiceRecordings.$inferSelect;
export type VoiceProfileStatus = VoiceProfileRow['status'];
export type VoiceRecordingKind = VoiceRecordingRow['kind'];

export async function getVoiceProfile(
  db: DbOrTx,
  ownerUserId: string,
): Promise<VoiceProfileRow | null> {
  const rows = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.ownerUserId, ownerUserId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create the owner's profile (consent is what the row records — it exists only
 * after the consent notice was accepted). Returns the existing row unchanged
 * when one is already there, so the call is idempotent.
 */
export async function createVoiceProfile(
  db: Database,
  params: {
    ownerUserId: string;
    providerKey: string;
    consentVersion: string;
    language?: string | null;
    now?: Date;
  },
): Promise<VoiceProfileRow> {
  const inserted = await db
    .insert(voiceProfiles)
    .values({
      ownerUserId: params.ownerUserId,
      providerKey: params.providerKey,
      consentVersion: params.consentVersion,
      consentAcceptedAt: params.now ?? new Date(),
      language: params.language ?? null,
    })
    .onConflictDoNothing({ target: voiceProfiles.ownerUserId })
    .returning();
  if (inserted[0]) return inserted[0];
  const existing = await getVoiceProfile(db, params.ownerUserId);
  if (!existing) throw new Error('Voice profile creation raced a delete; retry.');
  return existing;
}

export async function listVoiceRecordings(
  db: DbOrTx,
  params: { ownerUserId: string; voiceProfileId: string },
): Promise<VoiceRecordingRow[]> {
  return db
    .select()
    .from(voiceRecordings)
    .where(
      and(
        eq(voiceRecordings.ownerUserId, params.ownerUserId),
        eq(voiceRecordings.voiceProfileId, params.voiceProfileId),
      ),
    );
}

export async function getVoiceRecording(
  db: DbOrTx,
  params: { ownerUserId: string; voiceProfileId: string; kind: VoiceRecordingKind },
): Promise<VoiceRecordingRow | null> {
  const rows = await db
    .select()
    .from(voiceRecordings)
    .where(
      and(
        eq(voiceRecordings.ownerUserId, params.ownerUserId),
        eq(voiceRecordings.voiceProfileId, params.voiceProfileId),
        eq(voiceRecordings.kind, params.kind),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Store a freshly-uploaded recording, replacing the previous one of the same
 * kind. The replaced object is queued for deletion in this same transaction (the
 * durable guarantee); the returned `replacedStorageKey` lets the caller attempt
 * an immediate delete as the fast path AFTER commit.
 */
export async function replaceVoiceRecording(
  db: Database,
  params: {
    ownerUserId: string;
    voiceProfileId: string;
    kind: VoiceRecordingKind;
    storageProvider: string;
    storageKey: string;
    mimeType: string;
    byteSize: number;
    durationSeconds?: number | null;
    peakDbfs?: number | null;
    loudnessLufs?: number | null;
    captureSettings?: VoiceCaptureSettings | null;
  },
): Promise<{ recording: VoiceRecordingRow; replacedStorageKey: string | null }> {
  return withTransaction(db, async (tx) => {
    const previous = await getVoiceRecording(tx, params);
    if (previous) {
      await tx.delete(voiceRecordings).where(eq(voiceRecordings.id, previous.id));
      await queueStorageObjectDeletion(tx, {
        ownerUserId: params.ownerUserId,
        storageKey: previous.storageKey,
        reason: VOICE_RECORDING_DELETED_REASON,
        deleteAfter: new Date(),
      });
    }
    const inserted = await tx
      .insert(voiceRecordings)
      .values({
        ownerUserId: params.ownerUserId,
        voiceProfileId: params.voiceProfileId,
        kind: params.kind,
        storageProvider: params.storageProvider,
        storageKey: params.storageKey,
        mimeType: params.mimeType,
        byteSize: params.byteSize,
        durationSeconds: params.durationSeconds ?? null,
        peakDbfs: params.peakDbfs ?? null,
        loudnessLufs: params.loudnessLufs ?? null,
        captureSettings: params.captureSettings ?? null,
      })
      .returning();
    return { recording: inserted[0]!, replacedStorageKey: previous?.storageKey ?? null };
  });
}

/** Statuses a profile may be in when a NEW source validation is submitted. */
const VALIDATION_SUBMITTABLE: VoiceProfileStatus[] = ['draft', 'failed', 'awaiting_verification'];

export async function markValidationSubmitted(
  db: Database,
  params: { ownerUserId: string; providerTaskId: string; language?: string | null },
): Promise<VoiceProfileRow | null> {
  const rows = await db
    .update(voiceProfiles)
    .set({
      status: 'validating_source',
      providerValidationTaskId: params.providerTaskId,
      // A fresh validation restarts the whole provider workflow.
      providerVoiceTaskId: null,
      providerVoiceId: null,
      verificationPhrase: null,
      errorCode: null,
      errorMessageSafe: null,
      // A fresh task may be polled immediately (the throttle is per task).
      lastPolledAt: null,
      ...(params.language !== undefined ? { language: params.language } : {}),
    })
    .where(
      and(
        eq(voiceProfiles.ownerUserId, params.ownerUserId),
        inArray(voiceProfiles.status, VALIDATION_SUBMITTABLE),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function markVoiceCreationSubmitted(
  db: Database,
  params: { ownerUserId: string; providerTaskId: string },
): Promise<VoiceProfileRow | null> {
  const rows = await db
    .update(voiceProfiles)
    .set({
      status: 'creating_voice',
      providerVoiceTaskId: params.providerTaskId,
      providerVoiceId: null,
      errorCode: null,
      errorMessageSafe: null,
      lastPolledAt: null,
    })
    .where(
      and(
        eq(voiceProfiles.ownerUserId, params.ownerUserId),
        inArray(voiceProfiles.status, ['awaiting_verification', 'failed']),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Stamp a provider poll (refresh-on-read throttle), regardless of outcome. */
export async function touchVoiceProfilePolled(
  db: Database,
  params: { ownerUserId: string; now?: Date },
): Promise<void> {
  await db
    .update(voiceProfiles)
    .set({ lastPolledAt: params.now ?? new Date() })
    .where(eq(voiceProfiles.ownerUserId, params.ownerUserId));
}

/**
 * Apply a validation poll outcome. Guarded on `validating_source` so a late
 * poll response can never regress a profile the user already moved forward.
 */
export async function applyValidationOutcome(
  db: Database,
  params: {
    ownerUserId: string;
    outcome:
      | { status: 'awaiting_verification'; verificationPhrase: string }
      | { status: 'failed'; errorCode: string; errorMessageSafe: string };
  },
): Promise<VoiceProfileRow | null> {
  const { outcome } = params;
  const rows = await db
    .update(voiceProfiles)
    .set(
      outcome.status === 'awaiting_verification'
        ? {
            status: 'awaiting_verification',
            verificationPhrase: outcome.verificationPhrase,
            errorCode: null,
            errorMessageSafe: null,
          }
        : {
            status: 'failed',
            errorCode: outcome.errorCode,
            errorMessageSafe: outcome.errorMessageSafe,
          },
    )
    .where(
      and(
        eq(voiceProfiles.ownerUserId, params.ownerUserId),
        eq(voiceProfiles.status, 'validating_source'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Apply a creation poll outcome; guarded on `creating_voice` like validation. */
export async function applyVoiceCreationOutcome(
  db: Database,
  params: {
    ownerUserId: string;
    outcome:
      | { status: 'ready'; providerVoiceId: string }
      | { status: 'failed'; errorCode: string; errorMessageSafe: string };
  },
): Promise<VoiceProfileRow | null> {
  const { outcome } = params;
  const rows = await db
    .update(voiceProfiles)
    .set(
      outcome.status === 'ready'
        ? {
            status: 'ready',
            providerVoiceId: outcome.providerVoiceId,
            errorCode: null,
            errorMessageSafe: null,
          }
        : {
            status: 'failed',
            errorCode: outcome.errorCode,
            errorMessageSafe: outcome.errorMessageSafe,
          },
    )
    .where(
      and(
        eq(voiceProfiles.ownerUserId, params.ownerUserId),
        eq(voiceProfiles.status, 'creating_voice'),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Disable (`ready` -> `disabled`) or re-enable (`disabled` -> `ready`). */
export async function setVoiceProfileEnabled(
  db: Database,
  params: { ownerUserId: string; enabled: boolean },
): Promise<VoiceProfileRow | null> {
  const [from, to]: [VoiceProfileStatus, VoiceProfileStatus] = params.enabled
    ? ['disabled', 'ready']
    : ['ready', 'disabled'];
  const rows = await db
    .update(voiceProfiles)
    .set({ status: to })
    .where(and(eq(voiceProfiles.ownerUserId, params.ownerUserId), eq(voiceProfiles.status, from)))
    .returning();
  return rows[0] ?? null;
}

/**
 * Hard-delete the profile (recordings cascade). Each recording object is queued
 * for deletion in this same transaction (the durable guarantee); the returned
 * storage keys let the caller attempt an immediate delete as the fast path.
 */
export async function deleteVoiceProfile(
  db: Database,
  ownerUserId: string,
): Promise<{ deleted: boolean; storageKeys: string[] }> {
  return withTransaction(db, async (tx) => {
    const profile = await getVoiceProfile(tx, ownerUserId);
    if (!profile) return { deleted: false, storageKeys: [] };
    const recordings = await listVoiceRecordings(tx, {
      ownerUserId,
      voiceProfileId: profile.id,
    });
    await tx.delete(voiceProfiles).where(eq(voiceProfiles.id, profile.id));
    for (const recording of recordings) {
      await queueStorageObjectDeletion(tx, {
        ownerUserId,
        storageKey: recording.storageKey,
        reason: VOICE_RECORDING_DELETED_REASON,
        deleteAfter: new Date(),
      });
    }
    return { deleted: true, storageKeys: recordings.map((row) => row.storageKey) };
  });
}

/**
 * The provider voice reference for generation — non-null ONLY for a `ready`
 * profile, so callers can never generate with a disabled/failed/deleted voice.
 */
export async function getReadyVoiceProfile(
  db: DbOrTx,
  ownerUserId: string,
): Promise<{ providerVoiceId: string; providerKey: string } | null> {
  const rows = await db
    .select({
      providerVoiceId: voiceProfiles.providerVoiceId,
      providerKey: voiceProfiles.providerKey,
      status: voiceProfiles.status,
    })
    .from(voiceProfiles)
    .where(eq(voiceProfiles.ownerUserId, ownerUserId))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== 'ready' || !row.providerVoiceId) return null;
  return { providerVoiceId: row.providerVoiceId, providerKey: row.providerKey };
}

/** Stamp generation usage (best-effort diagnostics; callers swallow failures). */
export async function touchVoiceProfileUsed(
  db: DbOrTx,
  params: { ownerUserId: string; now?: Date },
): Promise<void> {
  await db
    .update(voiceProfiles)
    .set({ lastUsedAt: params.now ?? new Date() })
    .where(eq(voiceProfiles.ownerUserId, params.ownerUserId));
}
