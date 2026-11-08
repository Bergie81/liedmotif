import { runMigrations } from 'graphile-worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, type TestDb } from '../test-support';
import { writeWorkerHeartbeat } from './heartbeat-repo';
import { reapStaleWorkerLocks } from './stale-lock-reaper';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('stale worker-lock reaper', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-stale-lock-reaper-test');
    // Install the worker's job-queue schema exactly as the worker migrator does.
    await runMigrations({ connectionString: TEST_DATABASE_URL! });
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await ctx.pool.query('delete from graphile_worker._private_jobs');
    await ctx.pool.query('delete from graphile_worker._private_job_queues');
    await ctx.pool.query(`delete from app_settings where key = 'workerHeartbeat'`);
  });

  /**
   * Seed one job, optionally on a serialized queue and optionally locked by a
   * worker pool `secondsAgo` ago. Locking a queued job locks both rows, exactly
   * as graphile-worker's job fetch does.
   */
  async function addJob(
    identifier: string,
    opts: { lockedBy?: string; secondsAgo?: number; queueName?: string } = {},
  ): Promise<void> {
    await ctx.pool.query('select graphile_worker.add_job($1, queue_name => $2)', [
      identifier,
      opts.queueName ?? null,
    ]);
    if (opts.lockedBy !== undefined) {
      await ctx.pool.query(
        `update graphile_worker._private_jobs
           set locked_at = now() - make_interval(secs => $1), locked_by = $2
         where task_id = (select id from graphile_worker._private_tasks where identifier = $3)`,
        [opts.secondsAgo ?? 0, opts.lockedBy, identifier],
      );
      if (opts.queueName) {
        await ctx.pool.query(
          `update graphile_worker._private_job_queues
             set locked_at = now() - make_interval(secs => $1), locked_by = $2
           where queue_name = $3`,
          [opts.secondsAgo ?? 0, opts.lockedBy, opts.queueName],
        );
      }
    }
  }

  async function jobRow(identifier: string): Promise<{
    locked_at: Date | null;
    locked_by: string | null;
    is_available: boolean;
    attempts: number;
  }> {
    const { rows } = await ctx.pool.query(
      `select j.locked_at, j.locked_by, j.is_available, j.attempts
         from graphile_worker._private_jobs j
         join graphile_worker._private_tasks t on t.id = j.task_id
        where t.identifier = $1`,
      [identifier],
    );
    return rows[0];
  }

  async function queueRow(
    queueName: string,
  ): Promise<{ locked_at: Date | null; locked_by: string | null; is_available: boolean }> {
    const { rows } = await ctx.pool.query(
      `select locked_at, locked_by, is_available
         from graphile_worker._private_job_queues where queue_name = $1`,
      [queueName],
    );
    return rows[0];
  }

  /** Publish a heartbeat as a running worker would, with both times relative to now. */
  async function heartbeat(agesMs: { tsAgo: number; startedAtAgo: number }): Promise<void> {
    const now = Date.now();
    await writeWorkerHeartbeat(ctx.db, {
      ts: new Date(now - agesMs.tsAgo).toISOString(),
      pid: 1,
      state: 'ready',
      concurrency: 2,
      startedAt: new Date(now - agesMs.startedAtAgo).toISOString(),
    });
  }

  it('reaps a crashed worker lock — even a fresh one — so the job runs again', async () => {
    // The OOM-mid-poll case: the lock can be seconds old, so a min-age threshold
    // would miss it. After a crash the predecessor is gone; the lock must clear.
    await addJob('poll-music-generation', { lockedBy: 'pool-deadbeef', secondsAgo: 5 });
    expect((await jobRow('poll-music-generation')).is_available).toBe(false);

    const result = await reapStaleWorkerLocks(ctx.db);
    expect(result).toEqual({
      schemaPresent: true,
      jobsReaped: 1,
      queuesReaped: 0,
      preservedHolders: 0,
    });

    const after = await jobRow('poll-music-generation');
    expect(after.locked_at).toBeNull();
    expect(after.locked_by).toBeNull();
    // Clearing the lock recomputes the generated is_available column → runnable.
    expect(after.is_available).toBe(true);
  });

  it('clears the serialized queue row too, so the reaped job is actually fetchable', async () => {
    // A job whose queue row stays locked is runnable but never fetched: the job
    // fetch skips unavailable queues, so analysis would stall until graphile's
    // own 4-hour reclaim.
    await addJob('analyze-track-bpm-key', {
      lockedBy: 'pool-deadbeef',
      secondsAgo: 30,
      queueName: 'track-analysis',
    });

    const result = await reapStaleWorkerLocks(ctx.db);
    expect(result).toEqual({
      schemaPresent: true,
      jobsReaped: 1,
      queuesReaped: 1,
      preservedHolders: 0,
    });

    expect(await queueRow('track-analysis')).toMatchObject({
      locked_at: null,
      locked_by: null,
      is_available: true,
    });
  });

  it('leaves a live worker pool locked while reaping a dead one', async () => {
    // An overlapping deploy or an accidental second replica must not release the
    // jobs the running worker is executing right now.
    await heartbeat({ tsAgo: 2_000, startedAtAgo: 120_000 });
    await addJob('poll-music-generation', { lockedBy: 'pool-live', secondsAgo: 10 });
    await addJob('download-final-audio', { lockedBy: 'pool-dead', secondsAgo: 600 });

    const result = await reapStaleWorkerLocks(ctx.db);
    expect(result).toEqual({
      schemaPresent: true,
      jobsReaped: 1,
      queuesReaped: 0,
      preservedHolders: 1,
    });

    expect(await jobRow('poll-music-generation')).toMatchObject({ locked_by: 'pool-live' });
    expect(await jobRow('download-final-audio')).toMatchObject({ locked_by: null });
  });

  it('reaps locks newer than a stale heartbeat — the crashed worker wrote it', async () => {
    // The crash case leaves the dead worker's own heartbeat behind; only its
    // freshness may protect anything, never its mere presence.
    await heartbeat({ tsAgo: 300_000, startedAtAgo: 600_000 });
    await addJob('poll-music-generation', { lockedBy: 'pool-dead', secondsAgo: 5 });

    const result = await reapStaleWorkerLocks(ctx.db);
    expect(result).toEqual({
      schemaPresent: true,
      jobsReaped: 1,
      queuesReaped: 0,
      preservedHolders: 0,
    });
    expect(await jobRow('poll-music-generation')).toMatchObject({ locked_by: null });
  });

  it('is a no-op that leaves an unlocked job and its retry state untouched', async () => {
    await addJob('sweep-active-sessions');
    // A partially-retried but currently-available job must keep its attempts.
    await ctx.pool.query(
      `update graphile_worker._private_jobs set attempts = 1
         where task_id = (select id from graphile_worker._private_tasks where identifier = 'sweep-active-sessions')`,
    );
    const before = await jobRow('sweep-active-sessions');

    const result = await reapStaleWorkerLocks(ctx.db);
    expect(result).toEqual({
      schemaPresent: true,
      jobsReaped: 0,
      queuesReaped: 0,
      preservedHolders: 0,
    });

    expect(await jobRow('sweep-active-sessions')).toEqual(before);
  });
});
