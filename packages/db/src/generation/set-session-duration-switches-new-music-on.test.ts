import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { setSessionDuration, setSessionMode } from './session-command-repo';

describe.skipIf(!TEST_DATABASE_URL)('choosing No limit on a Session that is off', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('session-duration-mode-test');
  }, 60000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, GENERATION_FIXTURE_TABLES);
  });

  async function offWithTarget() {
    const ownerUserId = await createUser(ctx.db);
    const sessionId = await createSession(ctx.db, { ownerUserId });
    await setSessionDuration(ctx.db, { ownerUserId, sessionId, targetDurationMinutes: 40 });
    await setSessionMode(ctx.db, { ownerUserId, sessionId, mode: 'repeat' });
    return { ownerUserId, sessionId };
  }

  it('clears the target and switches on in one write', async () => {
    const ids = await offWithTarget();

    const session = await setSessionDuration(ctx.db, {
      ...ids,
      targetDurationMinutes: null,
      sessionMode: 'keep_going',
    });

    expect(session).toMatchObject({ targetDurationMinutes: null, sessionMode: 'keep_going' });
  });

  it('leaves the Session off when only the target is cleared', async () => {
    const ids = await offWithTarget();

    const session = await setSessionDuration(ctx.db, { ...ids, targetDurationMinutes: null });

    expect(session).toMatchObject({ targetDurationMinutes: null, sessionMode: 'repeat' });
  });

  it('never lets a target sit on a Session that is off', async () => {
    const ids = await offWithTarget();

    const session = await setSessionDuration(ctx.db, {
      ...ids,
      targetDurationMinutes: 20,
      sessionMode: 'repeat',
    });

    expect(session).toMatchObject({ targetDurationMinutes: 20, sessionMode: 'keep_going' });
  });
});
