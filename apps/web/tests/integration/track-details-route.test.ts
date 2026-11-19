import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRACK_DATA_PROMPT_LENGTH } from '@liedmotif/shared';
import { listenerProfiles, updateUsageLimits } from '@liedmotif/db';
import {
  connectTestDb,
  createGenerationRequest,
  createProviderJob,
  createSession,
  createTrack,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, ownerUserId: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
  getAppSession: async () => (holder.ownerUserId ? { user: { id: holder.ownerUserId } } : null),
}));

const { GET } = await import('@/app/api/tracks/[trackId]/details/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

const FIXTURE_TABLES = [...GENERATION_FIXTURE_TABLES, 'listener_profiles', 'app_settings'] as const;

function getDetails(trackId: string) {
  return GET(new Request(`http://localhost/api/tracks/${trackId}/details`), {
    params: Promise.resolve({ trackId }),
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('track-details-route-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, FIXTURE_TABLES);
  holder.ownerUserId = null;
});

describe.skipIf(skip)('GET /api/tracks/[trackId]/details', () => {
  it('returns the full descriptive payload for an enriched vocal track', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    await testDb.db.insert(listenerProfiles).values({ ownerUserId, artistName: 'DJ John' });
    const sessionId = await createSession(testDb.db, {
      ownerUserId,
      title: 'Deep Focus Coding',
      userPrompt: 'calm music for late-night coding',
    });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
      stylePrompt: 'lofi hip hop, mellow, 80 bpm',
      expandedPrompt: 'A mellow lofi set for deep work…',
      styleSnapshot: { stylePrompt: 'lofi hip hop', language: 'German' },
    });
    const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId,
      title: 'Rainfall Circuit',
      durationSeconds: 184,
      vocalMode: 'vocal',
      genreTags: ['lofi', 'ambient'],
      bpmEstimate: 87.6,
      providerModel: 'V4_5',
      rightsNote: 'Personal, non-commercial use.',
      activity: 'coding',
      mood: 'calm',
      energy: 'low',
    });

    const response = await getDetails(trackId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      title: 'Rainfall Circuit',
      sessionTitle: 'Deep Focus Coding',
      artistName: 'DJ John',
      durationSeconds: 184,
      userPrompt: 'calm music for late-night coding',
      stylePrompt: 'lofi hip hop, mellow, 80 bpm',
      expandedPrompt: 'A mellow lofi set for deep work…',
      genreTags: ['lofi', 'ambient'],
      activity: 'coding',
      mood: 'calm',
      energy: 'low',
      vocalMode: 'vocal',
      language: 'German',
      bpm: 88,
      providerKey: 'mock',
      providerModel: 'V4_5',
      licenseNote: 'Personal, non-commercial use.',
    });
    expect(typeof body.data.createdAt).toBe('string');
  });

  it("hands the Admin's Instance timezone along so the Generated date is shown in it", async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    await updateUsageLimits(testDb.db, { resetTimezone: 'Europe/Berlin' });
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId,
    });

    const body = await (await getDetails(trackId)).json();
    expect(body.data.timezone).toBe('Europe/Berlin');
  });

  it('nulls the absent fields of a sparse instrumental track and falls back to the User name', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId,
    });

    const body = await (await getDetails(trackId)).json();
    expect(body.data).toMatchObject({
      sessionTitle: null,
      artistName: 'Test Admin',
      userPrompt: null,
      stylePrompt: null,
      expandedPrompt: null,
      genreTags: [],
      activity: null,
      mood: null,
      energy: null,
      vocalMode: 'instrumental',
      language: null,
      bpm: null,
      providerModel: null,
      licenseNote: null,
    });
  });

  it('404s a malformed id and a cross-owner track alike', async () => {
    const ownerUserId = await createUser(testDb.db);
    holder.ownerUserId = ownerUserId;
    const sessionId = await createSession(testDb.db, { ownerUserId });
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId,
      activitySessionId: sessionId,
    });
    const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    const trackId = await createTrack(testDb.db, {
      ownerUserId,
      generationRequestId: requestId,
      providerJobId,
    });

    expect((await getDetails('not-a-uuid')).status).toBe(404);

    holder.ownerUserId = await createUser(testDb.db); // someone else
    expect((await getDetails(trackId)).status).toBe(404);
  });

  it('401s without an admin session', async () => {
    expect((await getDetails('e3b0c442-98fc-4c14-b39f-92d1282048c0')).status).toBe(401);
  });
});

// A Track's prompt provenance is frozen at generation time: the request's stamp
// wins, and only a legacy request without one falls back to the session's live
// value.
describe.skipIf(skip)('GET /api/tracks/[trackId]/details — frozen prompt provenance', () => {
  let sessionId: string;

  async function seedTrack(request: { userPrompt?: string | null }): Promise<string> {
    const requestId = await createGenerationRequest(testDb.db, {
      ownerUserId: holder.ownerUserId!,
      activitySessionId: sessionId,
      ...request,
    });
    const providerJobId = await createProviderJob(testDb.db, { generationRequestId: requestId });
    return createTrack(testDb.db, {
      ownerUserId: holder.ownerUserId!,
      generationRequestId: requestId,
      providerJobId,
    });
  }

  async function promptOf(trackId: string): Promise<string | null> {
    const body = await (await getDetails(trackId)).json();
    return body.data.userPrompt;
  }

  beforeEach(async () => {
    if (skip) return;
    holder.ownerUserId = await createUser(testDb.db);
    // A session that has since had a Change Vibe with text: its live prompt is
    // the accumulated history.
    sessionId = await createSession(testDb.db, {
      ownerUserId: holder.ownerUserId,
      userPrompt: 'calm music for coding\n\nmehr rockiger',
    });
  });

  it('shows each Track the prompt history that produced it, not the session’s latest', async () => {
    const beforeChange = await seedTrack({ userPrompt: 'calm music for coding' });
    const afterChange = await seedTrack({ userPrompt: 'calm music for coding\n\nmehr rockiger' });

    expect(await promptOf(beforeChange)).toBe('calm music for coding');
    expect(await promptOf(afterChange)).toBe('calm music for coding\n\nmehr rockiger');
  });

  it('shows no prompt for a Track stamped with an empty history, whatever the session says now', async () => {
    const noHistory = await seedTrack({ userPrompt: '' });

    expect(await promptOf(noHistory)).toBeNull();
  });

  it('falls back to the session’s live prompt for a legacy Track that was never stamped', async () => {
    const legacy = await seedTrack({});

    expect(await promptOf(legacy)).toBe('calm music for coding\n\nmehr rockiger');
  });

  it('caps the legacy fallback at the track-data bound', async () => {
    await testDb.pool.query('update activity_sessions set user_prompt = $1 where id = $2', [
      'x'.repeat(MAX_TRACK_DATA_PROMPT_LENGTH + 200),
      sessionId,
    ]);
    const legacy = await seedTrack({});

    const prompt = await promptOf(legacy);
    expect(prompt).toHaveLength(MAX_TRACK_DATA_PROMPT_LENGTH);
    expect(prompt?.endsWith('…')).toBe(true);
  });

  it('keeps a Track’s stamped prompt after its session is gone', async () => {
    const trackId = await seedTrack({ userPrompt: 'calm music for coding' });
    await testDb.pool.query('delete from activity_sessions where id = $1', [sessionId]);

    expect(await promptOf(trackId)).toBe('calm music for coding');
  });
});
