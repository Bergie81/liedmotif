import { describe, expect, it, vi } from 'vitest';
import type { WorkerHeartbeat } from '@liedmotif/db';
import { createDbHeartbeatWriter } from './db-heartbeat';

function writer(overrides: { write?: (record: WorkerHeartbeat) => Promise<void> } = {}) {
  const written: WorkerHeartbeat[] = [];
  const write =
    overrides.write ??
    (async (record: WorkerHeartbeat) => {
      written.push(record);
    });
  const logWarn = vi.fn();
  const logInfo = vi.fn();
  const publish = createDbHeartbeatWriter({
    write,
    logWarn,
    logInfo,
    concurrency: 3,
    startedAt: new Date('2026-07-30T11:00:00.000Z'),
    pid: 4242,
  });
  return { publish, written, logWarn, logInfo };
}

describe('createDbHeartbeatWriter', () => {
  it('writes the full record for the given state', async () => {
    const { publish, written } = writer();
    await publish('ready', new Date('2026-07-30T12:00:00.000Z'));
    expect(written).toEqual([
      {
        ts: '2026-07-30T12:00:00.000Z',
        pid: 4242,
        state: 'ready',
        concurrency: 3,
        startedAt: '2026-07-30T11:00:00.000Z',
      },
    ]);
  });

  it('never throws, and logs only the first of consecutive failures', async () => {
    const { publish, logWarn } = writer({
      write: () => Promise.reject(new Error('db down')),
    });
    await publish('ready');
    await publish('ready');
    await publish('ready');
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('logs recovery once when writes succeed again, then stays quiet', async () => {
    let fail = true;
    const { publish, logWarn, logInfo } = writer({
      write: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve()),
    });
    await publish('ready');
    fail = false;
    await publish('ready');
    await publish('ready');
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
  });
});
