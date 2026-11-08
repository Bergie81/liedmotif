import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceProfile, userProfiles, voiceProfiles, type UserRole } from '@liedmotif/db';
import { eq } from 'drizzle-orm';
import {
  connectTestDb,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

// The creation-path own-voice gate: "Use my voice" is honored or rejected
// BEFORE any session row exists — never silently downgraded to generic vocals.
// Runs the real Start Session route against the test DB with the mock music
// provider (customVoice-capable), toggling only the profile's readiness.

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  llmConfigured: false,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
// Hermetic providers: mock music and, only where a test asks, the mock text
// LLM — no network, no spend.
vi.mock('@/lib/providers', async () => {
  const { mockLlmProvider, mockMusicProvider } = await import('@liedmotif/providers');
  const music = mockMusicProvider();
  const llm = mockLlmProvider();
  return {
    getLlmProvider: async () => (holder.llmConfigured ? llm : null),
    getMusicProvider: () => music,
  };
});

const { POST } = await import('@/app/api/sessions/route');
const { POST: changeVibe } = await import('@/app/api/sessions/change-vibe/route');
const { OWN_VOICE_NOT_OFFERED_MESSAGE } = await import('@/lib/voice');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/** The gate resolves the viewer's role itself, so every fixture user needs a
 * profile row — exactly as every real signed-in user has one. */
async function createUserWithRole(role: UserRole): Promise<string> {
  const userId = await createUser(testDb.db);
  await testDb.db.insert(userProfiles).values({ userId, role });
  return userId;
}

function startOwnVoiceRequest(): Request {
  return new Request('http://localhost/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { mode: 'controls', controls: { vocal: 'vocal', ownVoice: true } },
      clientId: 'own-voice-gate-test',
    }),
  });
}

async function readyProfile(ownerUserId: string): Promise<void> {
  await createVoiceProfile(testDb.db, { ownerUserId, providerKey: 'mock', consentVersion: 'v1' });
  await testDb.db
    .update(voiceProfiles)
    .set({ status: 'ready', providerVoiceId: 'voice-ref-1' })
    .where(eq(voiceProfiles.ownerUserId, ownerUserId));
}

(skip ? describe.skip : describe)('Start Session own-voice gate', () => {
  beforeAll(async () => {
    testDb = await connectTestDb('liedmotif-own-voice-gate-test');
    holder.db = testDb.db;
  }, 60_000);
  afterAll(async () => {
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    // app_settings included: instance-wide usage limits left by another suite
    // (they carry no user FK) would otherwise 429 the Start route before the
    // own-voice gate under test is ever reached.
    await truncateTables(testDb.pool, [...GENERATION_FIXTURE_TABLES, 'app_settings']);
    holder.ownerUserId = await createUserWithRole('admin');
    holder.llmConfigured = false;
    // These pin the feature's behavior with the instance switch on.
    vi.stubEnv('OWN_VOICE_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('rejects an own-voice start with no ready profile — no session row created', async () => {
    const response = await POST(startOwnVoiceRequest());
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { ok: boolean; error?: { message?: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error?.message).toContain('Settings → My voice');
    const sessions = await testDb.pool.query('select count(*)::int as n from activity_sessions');
    expect(sessions.rows[0].n).toBe(0);
  });

  it('rejects when the profile exists but is disabled', async () => {
    await readyProfile(holder.ownerUserId!);
    await testDb.db
      .update(voiceProfiles)
      .set({ status: 'disabled' })
      .where(eq(voiceProfiles.ownerUserId, holder.ownerUserId!));
    expect((await POST(startOwnVoiceRequest())).status).toBe(400);
  });

  it('refuses a member with the member-shaped message — no session row, no Settings pointer', async () => {
    holder.ownerUserId = await createUserWithRole('member');
    const response = await POST(startOwnVoiceRequest());
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { ok: boolean; error?: { message?: string } };
    expect(payload.error?.message).toBe(OWN_VOICE_NOT_OFFERED_MESSAGE);
    expect(payload.error?.message).not.toContain('Settings');
    const sessions = await testDb.pool.query('select count(*)::int as n from activity_sessions');
    expect(sessions.rows[0].n).toBe(0);
  });

  it('creates the session (snapshot carries useOwnVoice) with a ready profile', async () => {
    await readyProfile(holder.ownerUserId!);
    const response = await POST(startOwnVoiceRequest());
    expect(response.status).toBe(200);
    const snapshot = await testDb.pool.query(
      'select session_style_snapshot as snapshot from activity_sessions',
    );
    expect(snapshot.rows[0].snapshot.useOwnVoice).toBe(true);
    expect(snapshot.rows[0].snapshot.vocalMode).toBe('vocal');
  });

  it.each([
    ['without a text LLM', false],
    ['with a text LLM', true],
  ])(
    'changes the vibe of a running own-voice session to generic vocals once the feature is off (%s)',
    async (_label, llmConfigured) => {
      holder.llmConfigured = llmConfigured;
      await readyProfile(holder.ownerUserId!);
      expect((await POST(startOwnVoiceRequest())).status).toBe(200);
      const started = await testDb.pool.query<{ id: string }>('select id from activity_sessions');

      vi.stubEnv('OWN_VOICE_ENABLED', '');
      const response = await changeVibe(
        new Request('http://localhost/api/sessions/change-vibe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: started.rows[0]!.id,
            input: { mode: 'prompt', prompt: 'a bit darker' },
          }),
        }),
      );
      expect(response.status).toBe(200);
      const snapshot = await testDb.pool.query(
        'select session_style_snapshot as snapshot from activity_sessions',
      );
      expect(snapshot.rows[0].snapshot.useOwnVoice).toBe(false);
    },
  );
});
