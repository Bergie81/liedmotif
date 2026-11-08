import { runMigrations } from 'graphile-worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../client';
import { connectTestDb, TEST_DATABASE_URL, type TestDb } from '../test-support';
import { getWorkerQueueStats } from './queue-stats-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('worker queue stats repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-queue-stats-repo-test');
    // Install the worker's job-queue schema exactly as the worker migrator does
    // (idempotent), so the stats query has its real target.
    await runMigrations({ connectionString: TEST_DATABASE_URL! });
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await ctx.pool.query('delete from graphile_worker._private_jobs');
  });

  async function addJob(
    identifier: string,
    opts: { runAt?: string; lockedAgoHours?: number; exhausted?: boolean } = {},
  ): Promise<void> {
    await ctx.pool.query(`select graphile_worker.add_job($1, run_at => $2)`, [
      identifier,
      opts.runAt ?? new Date().toISOString(),
    ]);
    if (opts.lockedAgoHours !== undefined) {
      await ctx.pool.query(
        `update graphile_worker._private_jobs
         set locked_at = now() - make_interval(hours => $1), locked_by = 'test-worker'
         where task_id = (select id from graphile_worker._private_tasks where identifier = $2)`,
        [opts.lockedAgoHours, identifier],
      );
    }
    if (opts.exhausted) {
      await ctx.pool.query(
        `update graphile_worker._private_jobs
         set attempts = max_attempts
         where task_id = (select id from graphile_worker._private_tasks where identifier = $1)`,
        [identifier],
      );
    }
  }

  it('reports zero counts on an empty queue', async () => {
    expect(await getWorkerQueueStats(ctx.db)).toEqual({
      jobsInFlight: 0,
      queuedJobs: 0,
      failedJobs: 0,
    });
  });

  it('counts runnable, locked, and permanently failed jobs into their buckets', async () => {
    await addJob('stats-runnable');
    await addJob('stats-locked', { lockedAgoHours: 1 });
    await addJob('stats-dead', { exhausted: true });
    expect(await getWorkerQueueStats(ctx.db)).toEqual({
      jobsInFlight: 1,
      queuedJobs: 1,
      failedJobs: 1,
    });
  });

  it('excludes future-scheduled jobs (recurring cron rows) from the queued count', async () => {
    await addJob('stats-cron', { runAt: '2999-01-01T00:00:00Z' });
    expect(await getWorkerQueueStats(ctx.db)).toEqual({
      jobsInFlight: 0,
      queuedJobs: 0,
      failedJobs: 0,
    });
  });

  it('treats a lock older than the 4h crashed-worker window as not in flight', async () => {
    await addJob('stats-stale-lock', { lockedAgoHours: 5 });
    expect(await getWorkerQueueStats(ctx.db)).toEqual({
      jobsInFlight: 0,
      queuedJobs: 0,
      failedJobs: 0,
    });
  });

  it('counts a job running its last attempt as in flight, not failed', async () => {
    await addJob('stats-last-attempt', { exhausted: true, lockedAgoHours: 1 });
    expect(await getWorkerQueueStats(ctx.db)).toEqual({
      jobsInFlight: 1,
      queuedJobs: 0,
      failedJobs: 0,
    });
  });

  it('counts a job out of attempts as failed once its lock has gone stale', async () => {
    await addJob('stats-stranded', { exhausted: true, lockedAgoHours: 5 });
    expect(await getWorkerQueueStats(ctx.db)).toEqual({
      jobsInFlight: 0,
      queuedJobs: 0,
      failedJobs: 1,
    });
  });

  it('returns null when the graphile schema is unavailable (best-effort contract)', async () => {
    const broken = { execute: () => Promise.reject(new Error('schema missing')) } as unknown;
    expect(await getWorkerQueueStats(broken as Database)).toBeNull();
  });

  it('pins the view columns the stats query reads, so a graphile upgrade fails loudly', async () => {
    const { rows } = await ctx.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'graphile_worker' and table_name = 'jobs'`,
    );
    const columns = rows.map((row) => row.column_name);
    for (const required of ['locked_at', 'run_at', 'attempts', 'max_attempts']) {
      expect(columns).toContain(required);
    }
  });
});
