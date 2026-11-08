import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  applyValidationOutcome,
  applyVoiceCreationOutcome,
  createVoiceProfile,
  deleteVoiceProfile,
  getReadyVoiceProfile,
  getVoiceProfile,
  getVoiceRecording,
  markValidationSubmitted,
  markVoiceCreationSubmitted,
  replaceVoiceRecording,
  setVoiceProfileEnabled,
  VOICE_RECORDING_DELETED_REASON,
} from './repo';
import { deletionQueueItems, user } from '../schema';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

async function seedUser(ctx: TestDb): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(user).values({ id, name: 'Owner', email: `${id}@example.test` });
  return id;
}

function recordingInput(ownerUserId: string, voiceProfileId: string) {
  return {
    ownerUserId,
    voiceProfileId,
    kind: 'source' as const,
    storageProvider: 'local-fs',
    storageKey: `voice/${ownerUserId}/${randomUUID()}.wav`,
    mimeType: 'audio/wav',
    byteSize: 1024,
    durationSeconds: 24.5,
    peakDbfs: -3.2,
  };
}

async function readyProfile(ctx: TestDb, ownerUserId: string) {
  await createVoiceProfile(ctx.db, { ownerUserId, providerKey: 'suno', consentVersion: 'v1' });
  await markValidationSubmitted(ctx.db, { ownerUserId, providerTaskId: 'validate-1' });
  await applyValidationOutcome(ctx.db, {
    ownerUserId,
    outcome: { status: 'awaiting_verification', verificationPhrase: 'Sing this phrase' },
  });
  await markVoiceCreationSubmitted(ctx.db, { ownerUserId, providerTaskId: 'create-1' });
  return applyVoiceCreationOutcome(ctx.db, {
    ownerUserId,
    outcome: { status: 'ready', providerVoiceId: 'voice-1' },
  });
}

describeIfDb('Voice profile repository', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-voice-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['user']);
  });

  /** Storage keys queued for deletion under this owner via the voice reason. */
  async function queuedKeys(ownerUserId: string): Promise<(string | null)[]> {
    const rows = await ctx.db
      .select({ storageKey: deletionQueueItems.storageKey })
      .from(deletionQueueItems)
      .where(
        and(
          eq(deletionQueueItems.ownerUserId, ownerUserId),
          eq(deletionQueueItems.reason, VOICE_RECORDING_DELETED_REASON),
        ),
      );
    return rows.map((row) => row.storageKey);
  }

  it('creates at most one profile per owner (idempotent create)', async () => {
    const ownerUserId = await seedUser(ctx);
    const first = await createVoiceProfile(ctx.db, {
      ownerUserId,
      providerKey: 'suno',
      consentVersion: 'v1',
      language: 'en',
    });
    const second = await createVoiceProfile(ctx.db, {
      ownerUserId,
      providerKey: 'suno',
      consentVersion: 'v2',
    });
    expect(second.id).toBe(first.id);
    expect(second.consentVersion).toBe('v1');
    expect(first.status).toBe('draft');
    expect(first.displayName).toBe('My voice');
  });

  it('replaces a recording of the same kind and queues the orphaned bytes for deletion', async () => {
    const ownerUserId = await seedUser(ctx);
    const profile = await createVoiceProfile(ctx.db, {
      ownerUserId,
      providerKey: 'suno',
      consentVersion: 'v1',
    });
    const first = await replaceVoiceRecording(ctx.db, recordingInput(ownerUserId, profile.id));
    expect(first.replacedStorageKey).toBeNull();

    const second = await replaceVoiceRecording(ctx.db, recordingInput(ownerUserId, profile.id));
    expect(second.replacedStorageKey).toBe(first.recording.storageKey);

    const stored = await getVoiceRecording(ctx.db, {
      ownerUserId,
      voiceProfileId: profile.id,
      kind: 'source',
    });
    expect(stored?.id).toBe(second.recording.id);

    // The replaced object is queued transactionally, so a transient immediate
    // delete failure in the route cannot strand the sensitive recording bytes.
    const queued = await queuedKeys(ownerUserId);
    expect(queued).toEqual([first.recording.storageKey]);
  });

  it('walks the full workflow to ready and exposes the provider voice reference', async () => {
    const ownerUserId = await seedUser(ctx);
    const profile = await readyProfile(ctx, ownerUserId);
    expect(profile?.status).toBe('ready');
    expect(profile?.providerVoiceId).toBe('voice-1');
    expect(await getReadyVoiceProfile(ctx.db, ownerUserId)).toEqual({
      providerVoiceId: 'voice-1',
      providerKey: 'suno',
    });
  });

  it('guards outcome writes on the in-flight status (late polls cannot regress)', async () => {
    const ownerUserId = await seedUser(ctx);
    await readyProfile(ctx, ownerUserId);
    // A stale validation poll response arriving after the profile is ready.
    const regressed = await applyValidationOutcome(ctx.db, {
      ownerUserId,
      outcome: { status: 'failed', errorCode: 'x', errorMessageSafe: 'stale' },
    });
    expect(regressed).toBeNull();
    expect((await getVoiceProfile(ctx.db, ownerUserId))?.status).toBe('ready');
  });

  it('hides a disabled profile from generation and re-enables cleanly', async () => {
    const ownerUserId = await seedUser(ctx);
    await readyProfile(ctx, ownerUserId);
    const disabled = await setVoiceProfileEnabled(ctx.db, { ownerUserId, enabled: false });
    expect(disabled?.status).toBe('disabled');
    expect(await getReadyVoiceProfile(ctx.db, ownerUserId)).toBeNull();

    const enabled = await setVoiceProfileEnabled(ctx.db, { ownerUserId, enabled: true });
    expect(enabled?.status).toBe('ready');
    expect(await getReadyVoiceProfile(ctx.db, ownerUserId)).not.toBeNull();
  });

  it('a fresh validation submit restarts the provider workflow state', async () => {
    const ownerUserId = await seedUser(ctx);
    await createVoiceProfile(ctx.db, { ownerUserId, providerKey: 'suno', consentVersion: 'v1' });
    await markValidationSubmitted(ctx.db, { ownerUserId, providerTaskId: 'validate-1' });
    await applyValidationOutcome(ctx.db, {
      ownerUserId,
      outcome: { status: 'failed', errorCode: 'noisy', errorMessageSafe: 'Too noisy' },
    });
    const resubmitted = await markValidationSubmitted(ctx.db, {
      ownerUserId,
      providerTaskId: 'validate-2',
      language: 'de',
    });
    expect(resubmitted?.status).toBe('validating_source');
    expect(resubmitted?.providerValidationTaskId).toBe('validate-2');
    expect(resubmitted?.errorMessageSafe).toBeNull();
    expect(resubmitted?.verificationPhrase).toBeNull();
    expect(resubmitted?.language).toBe('de');
  });

  it('rejects a validation submit while one is already in flight', async () => {
    const ownerUserId = await seedUser(ctx);
    await createVoiceProfile(ctx.db, { ownerUserId, providerKey: 'suno', consentVersion: 'v1' });
    await markValidationSubmitted(ctx.db, { ownerUserId, providerTaskId: 'validate-1' });
    const second = await markValidationSubmitted(ctx.db, {
      ownerUserId,
      providerTaskId: 'validate-2',
    });
    expect(second).toBeNull();
  });

  it('hard-deletes the profile and returns storage keys for cleanup', async () => {
    const ownerUserId = await seedUser(ctx);
    const profile = await createVoiceProfile(ctx.db, {
      ownerUserId,
      providerKey: 'suno',
      consentVersion: 'v1',
    });
    const { recording } = await replaceVoiceRecording(
      ctx.db,
      recordingInput(ownerUserId, profile.id),
    );
    const result = await deleteVoiceProfile(ctx.db, ownerUserId);
    expect(result.deleted).toBe(true);
    expect(result.storageKeys).toEqual([recording.storageKey]);
    expect(await getVoiceProfile(ctx.db, ownerUserId)).toBeNull();

    // The recording bytes are queued in the same transaction as the row delete,
    // so profile deletion never strands them on a transient storage error.
    expect(await queuedKeys(ownerUserId)).toEqual([recording.storageKey]);

    // Idempotent: a second delete is a clean no-op.
    expect(await deleteVoiceProfile(ctx.db, ownerUserId)).toEqual({
      deleted: false,
      storageKeys: [],
    });
  });
});
