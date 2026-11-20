import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlaylistDetail } from '@liedmotif/db';
import {
  connectTestDb,
  createQueueSlotAtRevision,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { convertSessionToPlaylistResponseSchema } from '@liedmotif/shared';

// POST /api/sessions/convert-to-playlist: the owner files a Session's listed
// Tracks into a new Playlist; a foreign id reads as absent (the 404 IDOR posture).

const holder = vi.hoisted(() => ({ db: null as unknown, owner: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAppSession: async () => (holder.owner ? { user: { id: holder.owner } } : null),
}));

const { POST } = await import('@/app/api/sessions/convert-to-playlist/route');

const TABLES = ['playlist_tracks', 'playlists', ...GENERATION_FIXTURE_TABLES] as const;
const skip = !TEST_DATABASE_URL;
const UNKNOWN_SESSION = '00000000-0000-4000-8000-000000000099';
let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('session-convert-to-playlist-route');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (testDb) await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, TABLES);
  holder.owner = await createUser(testDb.db);
});

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/sessions/convert-to-playlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe.skipIf(skip)('POST /api/sessions/convert-to-playlist', () => {
  it('answers the new Playlist, holding the Session Tracks, in the contract shape', async () => {
    const owner = holder.owner!;
    const sessionId = await createSession(testDb.db, {
      ownerUserId: owner,
      status: 'stopped',
      title: 'Late Drive',
    });
    const slot = await createQueueSlotAtRevision(testDb.db, {
      ownerUserId: owner,
      activitySessionId: sessionId,
      styleRevision: 1,
      position: 0,
    });

    const response = await post({ sessionId });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(convertSessionToPlaylistResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data.trackCount).toBe(1);
    const detail = await getPlaylistDetail(testDb.db, {
      ownerUserId: owner,
      playlistId: body.data.playlistId,
      cursor: null,
      limit: 10,
    });
    expect(detail?.playlist.name).toBe('Late Drive');
    expect(detail?.items.map((t) => t.id)).toEqual([slot.trackId]);
  });

  it('refuses a Session with no Tracks', async () => {
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.owner!,
      status: 'stopped',
    });

    const response = await post({ sessionId });
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toBe('This session has no tracks yet.');
  });

  it("reads an unknown or another owner's Session as not found", async () => {
    const stranger = await createUser(testDb.db);
    const foreign = await createSession(testDb.db, { ownerUserId: stranger, status: 'stopped' });

    for (const sessionId of [UNKNOWN_SESSION, foreign]) {
      const response = await post({ sessionId });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe('not_found');
    }
  });

  it('requires a signed-in owner and a valid body', async () => {
    expect((await post({ sessionId: 'nope' })).status).toBe(400);
    holder.owner = null;
    expect((await post({ sessionId: UNKNOWN_SESSION })).status).toBe(401);
  });
});
