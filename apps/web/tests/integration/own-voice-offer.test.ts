import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceProfile, voiceProfiles } from '@liedmotif/db';
import { eq } from 'drizzle-orm';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// The Admin half of the own-voice offer against the real database: a ready
// profile is the only thing that turns `setup` into `ready`. (The member
// `hidden` short-circuit is pinned db-free in `lib/resolve-own-voice-offer`.)

// Hermetic music provider (customVoice-capable) — no network, no spend.
vi.mock('@/lib/providers/providers', async () => {
  const { mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  return { getLlmProvider: async () => null, getMusicProvider: () => music };
});

const { resolveOwnVoiceOffer } = await import('@/lib/voice/voice');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

(skip ? describe.skip : describe)('resolveOwnVoiceOffer (admin, real database)', () => {
  beforeAll(async () => {
    // These pin the feature's behavior with the instance switch on.
    vi.stubEnv('OWN_VOICE_ENABLED', 'true');
    testDb = await connectTestDb('liedmotif-own-voice-offer-test');
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES]);
  });

  it('resolves setup with no voice profile', async () => {
    const ownerUserId = await createUser(testDb.db);
    await expect(
      resolveOwnVoiceOffer(testDb.db, { userId: ownerUserId, role: 'admin' }),
    ).resolves.toBe('setup');
  });

  it('resolves ready with a ready voice profile', async () => {
    const ownerUserId = await createUser(testDb.db);
    await createVoiceProfile(testDb.db, { ownerUserId, providerKey: 'mock', consentVersion: 'v1' });
    await testDb.db
      .update(voiceProfiles)
      .set({ status: 'ready', providerVoiceId: 'voice-ref-1' })
      .where(eq(voiceProfiles.ownerUserId, ownerUserId));
    await expect(
      resolveOwnVoiceOffer(testDb.db, { userId: ownerUserId, role: 'admin' }),
    ).resolves.toBe('ready');
  });
});
