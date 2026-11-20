import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import { generationOutputs } from '../schema';
import { createUser, GENERATION_FIXTURE_TABLES, seedReadyTrack } from '../generation/test-fixtures';
import { recordListening } from './listening-repo';
import { getHomeGreetingFacts } from './home-greeting-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const TABLES = [
  'generation_outputs',
  'listening_occurrences',
  'listening_preferences',
  'user_settings',
  ...GENERATION_FIXTURE_TABLES,
];

const NOW = new Date('2026-11-20T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describeIfDb('home greeting facts', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-home-greeting-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, TABLES);
  });

  async function produced(ownerUserId: string, at: Date) {
    await ctx.db
      .insert(generationOutputs)
      .values({ ownerUserId, analyticsTrackId: randomUUID(), firstPlayableAt: at });
  }

  it('counts every Track the owner generated, and those of the last seven days', async () => {
    const owner = await createUser(ctx.db);
    const other = await createUser(ctx.db);
    await produced(owner, daysAgo(30));
    await produced(owner, daysAgo(6));
    await produced(owner, daysAgo(1));
    await produced(other, daysAgo(1));

    const facts = await getHomeGreetingFacts(ctx.db, { ownerUserId: owner, now: NOW });

    expect(facts.totalTracks).toBe(3);
    expect(facts.tracksThisWeek).toBe(2);
  });

  it('reads when the owner last listened, and nothing for an owner who never has', async () => {
    const seeded = await seedReadyTrack(ctx.db);
    const at = daysAgo(9);
    await recordListening(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      occurrenceId: randomUUID(),
      trackId: seeded.trackId,
      sessionId: seeded.sessionId,
      surface: 'session',
      startedAt: new Date(at.getTime() - 60_000),
      listenedMs: 60_000,
      playedMs: 60_000,
      origin: 'auto',
      clientTimestamp: at,
      endReason: null,
      now: at,
    });
    const listener = await getHomeGreetingFacts(ctx.db, {
      ownerUserId: seeded.ownerUserId,
      now: NOW,
    });
    expect(listener.lastListenedAt?.toISOString()).toBe(at.toISOString());

    const newcomer = await getHomeGreetingFacts(ctx.db, {
      ownerUserId: await createUser(ctx.db),
      now: NOW,
    });
    expect(newcomer).toEqual({ totalTracks: 0, tracksThisWeek: 0, lastListenedAt: null });
  });
});
