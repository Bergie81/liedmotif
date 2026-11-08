import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import type { WorkerHeartbeat } from '../schema/types';
import {
  isWorkerHeartbeatFresh,
  readWorkerHeartbeat,
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  workerHeartbeatHealth,
  writeWorkerHeartbeat,
} from './heartbeat-repo';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

function record(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    ts: '2026-07-30T12:00:00.000Z',
    pid: 4242,
    state: 'ready',
    concurrency: 2,
    startedAt: '2026-07-30T11:00:00.000Z',
    ...overrides,
  };
}

describeIfDb('worker heartbeat repo', () => {
  let ctx: TestDb;
  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-worker-heartbeat-repo-test');
  }, 60_000);
  afterAll(async () => {
    await ctx?.pool.end();
  });
  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings']);
  });

  it('returns null when the worker has never reported', async () => {
    expect(await readWorkerHeartbeat(ctx.db)).toBeNull();
  });

  it('round-trips a heartbeat record', async () => {
    await writeWorkerHeartbeat(ctx.db, record());
    expect(await readWorkerHeartbeat(ctx.db)).toEqual(record());
  });

  it('overwrites the previous record in place (single row, last writer wins)', async () => {
    await writeWorkerHeartbeat(ctx.db, record({ state: 'starting' }));
    await writeWorkerHeartbeat(ctx.db, record({ state: 'ready', ts: '2026-07-30T12:00:10.000Z' }));
    expect(await readWorkerHeartbeat(ctx.db)).toEqual(
      record({ state: 'ready', ts: '2026-07-30T12:00:10.000Z' }),
    );
  });
});

describe('worker heartbeat freshness + health', () => {
  const ts = '2026-07-30T12:00:00.000Z';
  const tsMs = Date.parse(ts);

  it('is fresh within the stale window and stale beyond it', () => {
    expect(isWorkerHeartbeatFresh(record({ ts }), tsMs + WORKER_HEARTBEAT_STALE_AFTER_MS)).toBe(
      true,
    );
    expect(isWorkerHeartbeatFresh(record({ ts }), tsMs + WORKER_HEARTBEAT_STALE_AFTER_MS + 1)).toBe(
      false,
    );
  });

  it('maps a fresh ready worker to healthy', () => {
    expect(workerHeartbeatHealth(record({ ts }), tsMs + 1_000)).toBe('healthy');
  });

  it('maps fresh starting/degraded states to degraded', () => {
    expect(workerHeartbeatHealth(record({ ts, state: 'starting' }), tsMs + 1_000)).toBe('degraded');
    expect(workerHeartbeatHealth(record({ ts, state: 'degraded' }), tsMs + 1_000)).toBe('degraded');
  });

  it('maps a stale record to degraded — a worker that stopped reporting is a problem', () => {
    expect(workerHeartbeatHealth(record({ ts }), tsMs + 60_000)).toBe('degraded');
  });

  it('maps a never-written heartbeat to unavailable', () => {
    expect(workerHeartbeatHealth(null, tsMs)).toBe('unavailable');
  });
});
