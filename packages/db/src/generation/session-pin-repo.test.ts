import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PINNED_SESSIONS } from '@liedmotif/shared';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { createSession, createUser, GENERATION_FIXTURE_TABLES } from './test-fixtures';
import { listPinnedSessions, listResumableSessions } from './session-list-repo';
import { setSessionPinned } from './session-pin-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('session pinning', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-session-pin-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  it('pins and unpins a Session, newest pin first, moving it out of the unpinned list', async () => {
    const ownerUserId = await createUser(ctx.db);
    const first = await createSession(ctx.db, { ownerUserId, status: 'stopped' });
    const second = await createSession(ctx.db, { ownerUserId, status: 'stopped' });

    expect(await setSessionPinned(ctx.db, { ownerUserId, sessionId: first, pinned: true })).toBe(
      'ok',
    );
    expect(await setSessionPinned(ctx.db, { ownerUserId, sessionId: second, pinned: true })).toBe(
      'ok',
    );
    expect((await listPinnedSessions(ctx.db, { ownerUserId })).map((s) => s.id)).toEqual([
      second,
      first,
    ]);
    const all = await listResumableSessions(ctx.db, { ownerUserId, limit: 10 });
    expect(all.items.every((item) => item.pinned)).toBe(true);
    const unpinned = await listResumableSessions(ctx.db, {
      ownerUserId,
      limit: 10,
      excludePinned: true,
    });
    expect(unpinned.items).toEqual([]);

    expect(await setSessionPinned(ctx.db, { ownerUserId, sessionId: first, pinned: false })).toBe(
      'ok',
    );
    expect((await listPinnedSessions(ctx.db, { ownerUserId })).map((s) => s.id)).toEqual([second]);
  });

  it('refuses a pin past the limit but keeps re-pinning an already pinned Session a no-op', async () => {
    const ownerUserId = await createUser(ctx.db);
    const ids: string[] = [];
    for (let index = 0; index < MAX_PINNED_SESSIONS + 1; index += 1) {
      ids.push(await createSession(ctx.db, { ownerUserId, status: 'stopped' }));
    }
    const pinned = await Promise.all(
      ids.map((sessionId) => setSessionPinned(ctx.db, { ownerUserId, sessionId, pinned: true })),
    );
    expect(pinned.filter((result) => result === 'ok')).toHaveLength(MAX_PINNED_SESSIONS);
    expect(pinned.filter((result) => result === 'limit_reached')).toHaveLength(1);

    const pinnedId = ids[pinned.indexOf('ok')]!;
    expect(await setSessionPinned(ctx.db, { ownerUserId, sessionId: pinnedId, pinned: true })).toBe(
      'ok',
    );
  });

  it('lists only Stopped pinned Sessions and never touches another owner', async () => {
    const ownerUserId = await createUser(ctx.db);
    const otherOwner = await createUser(ctx.db);
    const active = await createSession(ctx.db, { ownerUserId, status: 'active' });
    const foreign = await createSession(ctx.db, { ownerUserId: otherOwner, status: 'stopped' });

    expect(await setSessionPinned(ctx.db, { ownerUserId, sessionId: active, pinned: true })).toBe(
      'ok',
    );
    expect(await listPinnedSessions(ctx.db, { ownerUserId })).toEqual([]);
    expect(await setSessionPinned(ctx.db, { ownerUserId, sessionId: foreign, pinned: true })).toBe(
      'not_found',
    );
  });
});
