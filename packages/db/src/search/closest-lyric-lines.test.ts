import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activitySessions, tracks } from '../schema';
import {
  connectTestDb,
  createSession,
  createUser,
  GENERATION_FIXTURE_TABLES,
  seedSessionTrack,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '../testing';
import { closestLyricLines } from './closest-lyric-lines';

// The lyric lines offered when a lyrics search matched nothing: ranked by
// spelling alone, and only ever from Tracks the same user's search could have
// returned.

const skip = !TEST_DATABASE_URL;

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('closest-lyric-lines-test');
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, GENERATION_FIXTURE_TABLES);
});

const stoppedSession = (ownerUserId: string, title: string) =>
  createSession(testDb.db, { ownerUserId, status: 'stopped', title });

async function seedSung(
  ownerUserId: string,
  sessionId: string,
  title: string,
  lyrics: string | null,
  status?: 'rejected' | 'deleted',
): Promise<string> {
  const id = await seedSessionTrack(testDb.db, ownerUserId, sessionId, { title, status });
  await testDb.db.update(tracks).set({ lyrics }).where(eq(tracks.id, id));
  return id;
}

const closest = (ownerUserId: string, query: string) =>
  closestLyricLines(testDb.db, { ownerUserId, query, limit: 5 });

describe.skipIf(skip)('closestLyricLines', () => {
  it('puts the nearest lyrics first, each with its best-fitting line', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Harbor Nights');
    const near = await seedSung(
      owner,
      sessionId,
      'Lighthouse',
      'the tide comes in\nthe lighthouse keeps its light\nwe sail on',
    );
    const far = await seedSung(owner, sessionId, 'Far Off', 'a light upstairs\nnobody home');

    expect(await closest(owner, 'the lihgthouse keeps')).toEqual([
      {
        id: near,
        title: 'Lighthouse',
        originSessionTitle: 'Harbor Nights',
        line: 'the lighthouse keeps its light',
      },
      { id: far, title: 'Far Off', originSessionTitle: 'Harbor Nights', line: 'a light upstairs' },
    ]);
  });

  it("never offers another user's Track", async () => {
    const owner = await createUser(testDb.db);
    const other = await createUser(testDb.db);
    const sessionId = await stoppedSession(other, 'Not Yours');
    await seedSung(other, sessionId, 'Lighthouse', 'the lighthouse keeps its light');

    expect(await closest(owner, 'the lihgthouse keeps')).toEqual([]);
  });

  it('leaves out a rejected and a deleted Track', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Harbor Nights');
    const kept = await seedSung(owner, sessionId, 'Kept', 'the lighthouse keeps its light');
    await seedSung(owner, sessionId, 'Rejected', 'the lighthouse keeps its light', 'rejected');
    await seedSung(owner, sessionId, 'Deleted', 'the lighthouse keeps its light', 'deleted');

    expect((await closest(owner, 'the lihgthouse keeps')).map((row) => row.id)).toEqual([kept]);
  });

  it('leaves out a Track without lyrics', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Harbor Nights');
    await seedSung(owner, sessionId, 'The Lighthouse Keeps', null);

    expect(await closest(owner, 'the lihgthouse keeps')).toEqual([]);
  });

  it('names no Session when its delete is pending', async () => {
    const owner = await createUser(testDb.db);
    const sessionId = await stoppedSession(owner, 'Harbor Nights');
    const id = await seedSung(owner, sessionId, 'Lighthouse', 'the lighthouse keeps its light');
    await testDb.db
      .update(activitySessions)
      .set({ deleteRequestedAt: new Date() })
      .where(eq(activitySessions.id, sessionId));

    expect(await closest(owner, 'the lihgthouse keeps')).toEqual([
      {
        id,
        title: 'Lighthouse',
        originSessionTitle: null,
        line: 'the lighthouse keeps its light',
      },
    ]);
  });
});
