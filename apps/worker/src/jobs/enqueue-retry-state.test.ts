import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeWorkerUtils, runMigrations, type WorkerUtils } from 'graphile-worker';
import { TEST_DATABASE_URL, connectTestDb, type TestDb } from '@liedmotif/db/testing';
import { enqueueBufferRefill, enqueuePollPreservingSchedule } from './enqueue';

// The two enqueues an every-minute cron drives, against the REAL
// `graphile_worker` schema: a re-enqueue must never resurrect a job's retry
// state. Graphile's `replace`/`preserve_run_at` modes always reset `attempts` to
// zero (and abandon an out-of-attempts row's key in favour of a fresh job), so a
// cron on either of those flattens exponential backoff into a once-a-minute
// hammer and keeps a permanently broken job out of the failed count forever.

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const CRON_ENQUEUES = [
  {
    label: 'buffer refill',
    key: 'buffer:session-1',
    enqueue: (utils: WorkerUtils) => enqueueBufferRefill(utils.addJob, 'session-1'),
  },
  {
    label: 'schedule-preserving poll',
    key: 'poll:job-1',
    enqueue: (utils: WorkerUtils) => enqueuePollPreservingSchedule(utils.addJob, 'job-1'),
  },
];

describeIfDb('cron-driven enqueues (retry state)', () => {
  let ctx: TestDb;
  let utils: WorkerUtils;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-enqueue-retry-state-test');
    await runMigrations({ connectionString: TEST_DATABASE_URL });
    utils = await makeWorkerUtils({ connectionString: TEST_DATABASE_URL });
  }, 60_000);
  afterAll(async () => {
    await utils?.release();
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await ctx.pool.query('delete from graphile_worker._private_jobs');
  });

  /** Every queued job under `key` — more than one means a re-enqueue duplicated it. */
  async function jobsFor(key: string): Promise<Array<{ attempts: number; runAt: Date }>> {
    const { rows } = await ctx.pool.query<{ attempts: number; run_at: Date }>(
      'select attempts, run_at from graphile_worker._private_jobs where key = $1',
      [key],
    );
    return rows.map((row) => ({ attempts: row.attempts, runAt: row.run_at }));
  }

  for (const { label, key, enqueue } of CRON_ENQUEUES) {
    it(`keeps a failing ${label} job's attempts and backoff across the next cron tick`, async () => {
      await enqueue(utils);
      const [queued] = await jobsFor(key);
      expect(queued).toBeDefined();

      // One failed attempt: Graphile parks the job at a backoff `run_at`.
      const backoffAt = new Date(Date.now() + 5 * 60_000);
      await ctx.pool.query(
        `update graphile_worker._private_jobs
            set attempts = 1, run_at = $2, last_error = 'boom'
          where key = $1`,
        [key, backoffAt],
      );

      await enqueue(utils);
      // The next tick coalesces onto the waiting job: one job, its attempt count
      // and its backoff intact, so `max_attempts` stays reachable.
      expect(await jobsFor(key)).toEqual([{ attempts: 1, runAt: backoffAt }]);

      // Out of attempts: the job stays stopped and visible as failed rather than
      // being replaced by a fresh runnable twin every minute.
      await ctx.pool.query(
        `update graphile_worker._private_jobs set attempts = max_attempts where key = $1`,
        [key],
      );
      const [exhausted] = await jobsFor(key);
      await enqueue(utils);
      expect(await jobsFor(key)).toEqual([exhausted]);
    });
  }
});
