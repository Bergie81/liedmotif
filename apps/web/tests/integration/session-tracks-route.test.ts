import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSessionTrackActivity } from '@liedmotif/db';
import {
  connectTestDb,
  createUser,
  createSession,
  createQueueSlotAtRevision,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, owner: null as string | null }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAppSession: async () => (holder.owner ? { user: { id: holder.owner } } : null),
}));

const { GET } = await import('@/app/api/sessions/tracks/route');
let testDb: TestDb;
beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  testDb = await connectTestDb('session-tracks-route');
  holder.db = testDb.db;
}, 60_000);
afterAll(async () => {
  if (testDb) await testDb.pool.end();
});
beforeEach(async () => {
  if (!TEST_DATABASE_URL) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
  holder.owner = await createUser(testDb.db);
});

function get(sessionId: string, query = '') {
  return GET(new Request(`http://localhost/api/sessions/tracks?sessionId=${sessionId}${query}`));
}

describe.skipIf(!TEST_DATABASE_URL)('Session track browsing', () => {
  it('pages the entire Session oldest first with a total independent of the Queue window', async () => {
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.owner!,
      status: 'stopped',
    });
    const ids: string[] = [];
    for (let position = 0; position < 35; position++) {
      const slot = await createQueueSlotAtRevision(testDb.db, {
        ownerUserId: holder.owner!,
        activitySessionId: sessionId,
        styleRevision: position < 20 ? 1 : 2,
        position,
        state: 'played',
      });
      ids.push(slot.trackId);
    }
    await testDb.pool.query('update tracks set duration_seconds = 120 where id = any($1::uuid[])', [
      ids,
    ]);
    const first = await (await get(sessionId, '&limit=20')).json();
    expect(first.ok).toBe(true);
    expect(first.data.total).toBe(35);
    expect(first.data.totalDurationSeconds).toBe(4200);
    expect(first.data.items.map((t: { id: string }) => t.id)).toEqual(ids.slice(0, 20));
    expect(first.data.items.map((t: { styleRevision: number | null }) => t.styleRevision)).toEqual(
      Array(20).fill(1),
    );
    const second = await (await get(sessionId, `&limit=20&cursor=${first.data.nextCursor}`)).json();
    expect(second.data.total).toBe(35);
    expect(second.data.totalDurationSeconds).toBe(4200);
    expect(second.data.items.map((t: { id: string }) => t.id)).toEqual(ids.slice(20));
    expect(second.data.items.map((t: { styleRevision: number | null }) => t.styleRevision)).toEqual(
      Array(15).fill(2),
    );
    expect(second.data.nextCursor).toBeNull();
  });
  it('includes playable history and set-aside Tracks once, but excludes unavailable and rejected material', async () => {
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.owner!,
      status: 'stopped',
    });
    const ids: string[] = [];
    for (let position = 0; position < 8; position++) {
      const { trackId, queueItemId } = await createQueueSlotAtRevision(testDb.db, {
        ownerUserId: holder.owner!,
        activitySessionId: sessionId,
        styleRevision: 1,
        position,
        state: position === 1 ? 'skipped' : 'played',
        playable: position !== 2,
      });
      ids.push(trackId);
      if (position === 1)
        await testDb.pool.query(
          'update activity_session_queue_items set vibe_switch_set_aside = true where id = $1',
          [queueItemId],
        );
      if (position === 3)
        await testDb.pool.query('update tracks set disliked_at = now() where id = $1', [trackId]);
      if (position === 4)
        await testDb.pool.query(
          "update activity_session_queue_items set state = 'rejected' where id = $1",
          [queueItemId],
        );
      if (position === 5)
        await testDb.pool.query("update tracks set status = 'pending' where id = $1", [trackId]);
      if (position === 6)
        await testDb.pool.query("update tracks set status = 'deleted' where id = $1", [trackId]);
      if (position === 7)
        await testDb.pool.query(
          'update track_audio_assets set is_playable = false where track_id = $1',
          [trackId],
        );
    }
    await testDb.pool.query(
      "insert into track_audio_assets (track_id, asset_type, storage_provider, storage_key, is_playable) values ($1, 'local_original', 'local-fs', 'test/final.mp3', true)",
      [ids[0]],
    );
    await testDb.pool.query(
      `update tracks set title = 'First Light', duration_seconds = 125, genre_tags = '["ambient"]'::jsonb where id = $1`,
      [ids[0]],
    );
    const { data } = await (await get(sessionId)).json();
    expect(data.total).toBe(2);
    expect(data.items).toEqual([
      { id: ids[0], title: 'First Light', durationSeconds: 125, styleRevision: 1 },
      { id: ids[1], title: null, durationSeconds: null, styleRevision: 1 },
    ]);
    const activity = await getSessionTrackActivity(testDb.db, {
      ownerUserId: holder.owner!,
      sessionId,
    });
    expect(activity.trackCount).toBe(data.total);
    expect(data.genreTags).toEqual(['ambient']);
    expect(data.genreTags).toEqual(activity.genreTags);
    expect(data.totalDurationSeconds).toBe(125);
    await testDb.pool.query('update tracks set duration_seconds = 65 where id = $1', [ids[1]]);
    const complete = await (await get(sessionId, '&limit=1')).json();
    expect(complete.data.totalDurationSeconds).toBe(190);
  });

  it('protects Session ownership and validates pagination bounds', async () => {
    const other = await createUser(testDb.db);
    const sessionId = await createSession(testDb.db, { ownerUserId: other, status: 'stopped' });
    expect((await get(sessionId)).status).toBe(404);
    expect((await get(sessionId, '&limit=101')).status).toBe(400);
    expect((await get(sessionId, '&cursor=-1')).status).toBe(400);
    holder.owner = null;
    expect((await get(sessionId)).status).toBe(401);
  });

  it('includes historical playable siblings with no Queue slot without creating one on read', async () => {
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.owner!,
      status: 'stopped',
    });
    const first = await createQueueSlotAtRevision(testDb.db, {
      ownerUserId: holder.owner!,
      activitySessionId: sessionId,
      styleRevision: 1,
      position: 0,
    });
    const sibling = await createQueueSlotAtRevision(testDb.db, {
      ownerUserId: holder.owner!,
      activitySessionId: sessionId,
      styleRevision: 1,
      position: 1,
    });
    await testDb.pool.query('delete from activity_session_queue_items where id = $1', [
      sibling.queueItemId,
    ]);
    const page = await (await get(sessionId, '&limit=1')).json();
    expect(page.data.total).toBe(2);
    expect(page.data.items.map((track: { id: string }) => track.id)).toEqual([first.trackId]);
    const next = await (await get(sessionId, `&limit=1&cursor=${page.data.nextCursor}`)).json();
    expect(next.data.items.map((track: { id: string }) => track.id)).toEqual([sibling.trackId]);
    expect(next.data.nextCursor).toBeNull();
    const slots = await testDb.pool.query(
      'select id from activity_session_queue_items where track_id = $1',
      [sibling.trackId],
    );
    expect(slots.rows).toEqual([]);
  });

  it('pages timestamp ties once even when Postgres stores sub-millisecond precision', async () => {
    const sessionId = await createSession(testDb.db, {
      ownerUserId: holder.owner!,
      status: 'stopped',
    });
    const ids: string[] = [];
    for (let position = 0; position < 3; position++) {
      const slot = await createQueueSlotAtRevision(testDb.db, {
        ownerUserId: holder.owner!,
        activitySessionId: sessionId,
        styleRevision: 1,
        position,
      });
      ids.push(slot.trackId);
    }
    await testDb.pool.query(
      "update tracks set created_at = '2026-09-13T10:00:00.123456Z' where id = any($1::uuid[])",
      [ids],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { data } = await (
        await get(sessionId, `&limit=1${cursor ? `&cursor=${cursor}` : ''}`)
      ).json();
      seen.push(...data.items.map((track: { id: string }) => track.id));
      cursor = data.nextCursor;
    } while (cursor && seen.length < 5);
    expect(seen).toEqual(ids.sort());
    expect(cursor).toBeNull();
  });
});
