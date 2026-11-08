import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, type Database, type Pool } from '../index';
import { user } from '../schema';
import {
  assertSafeTestDatabase,
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
} from '../test-support';
import { adminExists, createAdminProfile } from './state';
import { getInstanceSettings, upsertInstanceSettings } from './settings';
import { withSetupAdvisoryLock } from './lock';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('withSetupAdvisoryLock (serializes first-run setup)', () => {
  // A pool with enough connections for two racers (each holds a lock connection
  // plus runs its critical-section queries) so the test can't self-deadlock.
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL);
    // Ensure the schema exists before opening the wider pool.
    await (await connectTestDb('liedmotif-lock-migrate')).pool.end();
    pool = createPool(TEST_DATABASE_URL, { applicationName: 'liedmotif-lock-test', max: 6 });
    db = createDb(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateTables(pool, ['user', 'app_settings']);
  });

  /** A first-run setup attempt: under the lock, create the admin + write config IFF none exists. */
  function setupAttempt(index: number) {
    return withSetupAdvisoryLock(pool, async () => {
      if (await adminExists(db)) return { wrote: false, index };
      const userId = `admin-${index}`;
      await db
        .insert(user)
        .values({ id: userId, name: 'Admin', email: `admin-${index}@example.test` });
      await createAdminProfile(db, userId);
      await upsertInstanceSettings(db, { name: `config-${index}`, publicUrl: 'https://x' });
      return { wrote: true, index };
    });
  }

  it('lets exactly one of two racing submissions write; the loser writes nothing', async () => {
    const results = await Promise.all([setupAttempt(1), setupAttempt(2)]);

    const winners = results.filter((r) => r.wrote);
    expect(winners).toHaveLength(1);

    // Exactly one admin, and the stored config is the winner's (no partial overwrite).
    const admins = await db.select().from(user);
    expect(admins).toHaveLength(1);
    const settings = await getInstanceSettings(db);
    expect(settings?.name).toBe(`config-${winners[0]!.index}`);
    expect(admins[0]!.id).toBe(`admin-${winners[0]!.index}`);
  });

  it('survives a critical section longer than the pool of the process running it', async () => {
    // Setup holds this transaction open across sign-up and a placeholder-cover
    // upload; the web pool's ceilings are sized for a request, not for that.
    const tightPool = createPool(TEST_DATABASE_URL!, {
      applicationName: 'liedmotif-lock-timeout-test',
      tuning: {
        max: 1,
        statementTimeoutMs: 300,
        lockTimeoutMs: 200,
        idleInTransactionTimeoutMs: 400,
      },
    });
    try {
      const outcome = await withSetupAdvisoryLock(tightPool, async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return 'completed';
      });
      expect(outcome).toBe('completed');
    } finally {
      await tightPool.end();
    }
  }, 20_000);
});
