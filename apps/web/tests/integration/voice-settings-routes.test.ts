import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOCK_VERIFICATION_PHRASE,
  mockMusicProvider,
  type MusicProvider,
} from '@liedmotif/providers';
import { createMockStorageProvider, type StorageProvider } from '@liedmotif/storage';
import { voiceProfileViewSchema, type VoiceProfileView } from '@liedmotif/shared';
import {
  connectTestDb,
  createUser,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { multipartRequest } from '../helpers/multipart-request';

// End-to-end voice-profile workflow over the real routes + repo, with the mock
// music provider (instant provider completion) and mock storage: consent →
// source upload → validate → phrase → verification upload → verify → ready →
// disable/enable → delete (rows AND stored objects gone).

/** A same-origin API call: the guards look only at the absent `Origin`. */
const apiRequest = () => new Request('http://localhost/api');

const holder = vi.hoisted(() => ({
  db: null as unknown,
  ownerUserId: null as string | null,
  storage: null as unknown,
  music: null as unknown,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));
vi.mock('@/lib/providers', () => ({
  getStorageProvider: () => holder.storage,
  getMusicProvider: () => holder.music,
}));

const profileRoute = await import('@/app/api/settings/voice/route');
const recordingsRoute = await import('@/app/api/settings/voice/recordings/route');
const recordingServeRoute = await import('@/app/api/settings/voice/recordings/[kind]/route');
const validateRoute = await import('@/app/api/settings/voice/validate/route');
const verifyRoute = await import('@/app/api/settings/voice/verify/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
let storage: TrackingStorage;

/** The mock (temp-dir local-fs) provider with a live index of written keys,
 *  so tests can assert replacement/cleanup without a list API. */
interface TrackingStorage {
  provider: StorageProvider;
  keys: Set<string>;
  cleanup(): Promise<void>;
}

function trackingStorage(): TrackingStorage {
  const mock = createMockStorageProvider();
  const keys = new Set<string>();
  const provider: StorageProvider = {
    ...mock.provider,
    async write(input) {
      const stat = await mock.provider.write(input);
      keys.add(input.key);
      return stat;
    },
    async delete(key) {
      await mock.provider.delete(key);
      keys.delete(key);
    },
  };
  return { provider, keys, cleanup: mock.cleanup };
}

async function viewOf(response: Response): Promise<VoiceProfileView> {
  const payload = (await response.json()) as { ok: boolean; data?: { profile: unknown } };
  expect(payload.ok).toBe(true);
  return voiceProfileViewSchema.parse(payload.data?.profile);
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request('http://localhost/api/settings/voice', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ascii = new TextEncoder();

/** Silence in a real RIFF/WAVE container — what the browser recorder encodes. */
function wavBytes(byteLength = 2048): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  bytes.set(ascii.encode('RIFF'), 0);
  bytes.set(ascii.encode('WAVE'), 8);
  return bytes;
}

function uploadRequest(
  kind: string,
  seconds = 24,
  body: Uint8Array<ArrayBuffer> = wavBytes(),
): Request {
  const form = new FormData();
  form.set('file', new File([body], `${kind}.wav`, { type: 'audio/wav' }));
  form.set('kind', kind);
  form.set('durationSeconds', String(seconds));
  form.set('peakDbfs', '-3.5');
  return multipartRequest('http://localhost/api/settings/voice/recordings', form);
}

(skip ? describe.skip : describe)('Settings -> My voice routes', () => {
  beforeAll(async () => {
    testDb = await connectTestDb('liedmotif-voice-routes-test');
    holder.db = testDb.db;
  }, 60_000);
  afterAll(async () => {
    await testDb?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(testDb.pool, ['user']);
    holder.ownerUserId = await createUser(testDb.db);
    await storage?.cleanup();
    storage = trackingStorage();
    holder.storage = storage.provider;
    holder.music = mockMusicProvider();
    vi.stubEnv('OWN_VOICE_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('answers not-found on every route while the feature is switched off', async () => {
    vi.stubEnv('OWN_VOICE_ENABLED', '');
    const responses = await Promise.all([
      profileRoute.GET(apiRequest()),
      profileRoute.POST(jsonRequest('POST', { consent: true })),
      profileRoute.PATCH(jsonRequest('PATCH', { enabled: true })),
      profileRoute.DELETE(jsonRequest('DELETE', {})),
      recordingsRoute.POST(apiRequest()),
      recordingServeRoute.GET(apiRequest(), { params: Promise.resolve({ kind: 'source' }) }),
      validateRoute.POST(apiRequest()),
      verifyRoute.POST(apiRequest()),
    ]);
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(404));
  });

  it('walks the full setup workflow to ready with the mock provider', async () => {
    // No profile yet.
    expect((await viewOf(await profileRoute.GET(apiRequest()))).status).toBe('none');

    // Consent creates the profile.
    const created = await viewOf(
      await profileRoute.POST(jsonRequest('POST', { consent: true, language: 'en' })),
    );
    expect(created.status).toBe('draft');
    expect(created.language).toBe('en');

    // Upload the source sample, then submit it for validation.
    const uploaded = await viewOf(await recordingsRoute.POST(uploadRequest('source')));
    expect(uploaded.hasSourceRecording).toBe(true);
    const validating = await viewOf(await validateRoute.POST(apiRequest()));
    expect(validating.status).toBe('validating_source');

    // The mock provider completes instantly; the next GET lands the phrase.
    const awaiting = await viewOf(await profileRoute.GET(apiRequest()));
    expect(awaiting.status).toBe('awaiting_verification');
    expect(awaiting.verificationPhrase).toBe(MOCK_VERIFICATION_PHRASE);

    // Record the phrase and create the voice.
    await viewOf(await recordingsRoute.POST(uploadRequest('verification', 6)));
    const creating = await viewOf(await verifyRoute.POST(apiRequest()));
    expect(creating.status).toBe('creating_voice');
    const ready = await viewOf(await profileRoute.GET(apiRequest()));
    expect(ready.status).toBe('ready');
    // The provider voice reference itself never reaches the view.
    expect(JSON.stringify(ready)).not.toContain('mock-voice-1');
  });

  it('serves stored recordings to the owner and replaces bytes on re-record', async () => {
    await profileRoute.POST(jsonRequest('POST', { consent: true }));
    await recordingsRoute.POST(uploadRequest('source'));
    const first = await recordingServeRoute.GET(new Request('http://localhost'), {
      params: Promise.resolve({ kind: 'source' }),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('audio/wav');

    const keysAfterFirst = [...storage.keys];
    expect(keysAfterFirst).toHaveLength(1);
    await recordingsRoute.POST(uploadRequest('source'));
    const keysAfterSecond = [...storage.keys];
    expect(keysAfterSecond).toHaveLength(1);
    expect(keysAfterSecond[0]).not.toBe(keysAfterFirst[0]);

    const missing = await recordingServeRoute.GET(new Request('http://localhost'), {
      params: Promise.resolve({ kind: 'verification' }),
    });
    expect(missing.status).toBe(404);
  });

  it('rejects workflow submits out of order and uploads without a profile', async () => {
    const noProfile = await recordingsRoute.POST(uploadRequest('source'));
    expect(noProfile.status).toBe(409);

    await profileRoute.POST(jsonRequest('POST', { consent: true }));
    const noRecording = await validateRoute.POST(apiRequest());
    expect(noRecording.status).toBe(409);
    const noValidation = await verifyRoute.POST(apiRequest());
    expect(noValidation.status).toBe(409);
  });

  it('refuses bytes that are not a WAV container, and an over-long duration', async () => {
    await profileRoute.POST(jsonRequest('POST', { consent: true }));
    // Declared `audio/wav` is a label; these bytes are not a RIFF/WAVE stream.
    const notWav = await recordingsRoute.POST(
      uploadRequest('source', 24, new Uint8Array(2048).fill(7)),
    );
    expect(notWav.status).toBe(400);
    // A RIFF container of some other kind is refused too.
    const riffOnly = wavBytes();
    riffOnly.set(ascii.encode('AVI '), 8);
    expect((await recordingsRoute.POST(uploadRequest('source', 24, riffOnly))).status).toBe(400);
    // `durationSeconds` is client-declared; the contract bound is the documented
    // source maximum, not an arbitrarily larger one.
    expect((await recordingsRoute.POST(uploadRequest('source', 600))).status).toBe(400);

    expect(storage.keys.size).toBe(0);
    expect((await viewOf(await profileRoute.GET(apiRequest()))).hasSourceRecording).toBe(false);
  });

  it('refuses an oversized recording before the body is parsed', async () => {
    await profileRoute.POST(jsonRequest('POST', { consent: true }));
    // WAV is the fattest body the app takes, so this route carries its own
    // declared-size gate: it must answer 413 without buffering the upload.
    const request = uploadRequest('source');
    request.headers.set('content-length', String(64 * 1024 * 1024));
    const response = await recordingsRoute.POST(request);

    expect(response.status).toBe(413);
    expect((await viewOf(await profileRoute.GET(apiRequest()))).hasSourceRecording).toBe(false);
  });

  it('disable hides, enable restores, delete removes rows and stored objects', async () => {
    await profileRoute.POST(jsonRequest('POST', { consent: true }));
    await recordingsRoute.POST(uploadRequest('source'));
    await validateRoute.POST(apiRequest());
    await profileRoute.GET(apiRequest());
    await recordingsRoute.POST(uploadRequest('verification', 6));
    await verifyRoute.POST(apiRequest());
    expect((await viewOf(await profileRoute.GET(apiRequest()))).status).toBe('ready');

    const disabled = await viewOf(
      await profileRoute.PATCH(jsonRequest('PATCH', { enabled: false })),
    );
    expect(disabled.status).toBe('disabled');
    const enabled = await viewOf(await profileRoute.PATCH(jsonRequest('PATCH', { enabled: true })));
    expect(enabled.status).toBe('ready');

    expect(storage.keys.size).toBe(2);
    const deleted = await viewOf(await profileRoute.DELETE(apiRequest()));
    expect(deleted.status).toBe('none');
    expect(storage.keys.size).toBe(0);
  });

  it('a provider without voice support cannot create a profile', async () => {
    const base = mockMusicProvider();
    const { voice: _voice, ...withoutVoice } = base;
    holder.music = withoutVoice as MusicProvider;
    const response = await profileRoute.POST(jsonRequest('POST', { consent: true }));
    expect(response.status).toBe(400);
  });
});
