import { describe, expect, it, vi } from 'vitest';
import type { WorkerHeartbeat } from '@liedmotif/db';
import { awaitExclusiveWorkerSlot, type ExclusiveWorkerSlotDeps } from './replica-guard';

// A second worker process breaks queue exclusivity (the boot reaper
// releases locks it judges dead). The only cross-process liveness signal is the
// heartbeat record, and freshness alone cannot separate a live peer from a
// predecessor SIGKILLed a second ago — movement can.

const START = Date.parse('2026-08-05T12:00:00.000Z');

function record(tsMs: number, pid = 4242): WorkerHeartbeat {
  return {
    ts: new Date(tsMs).toISOString(),
    pid,
    state: 'ready',
    concurrency: 2,
    startedAt: new Date(tsMs - 60_000).toISOString(),
  };
}

/** A clock only `sleep` advances, so the wait resolves deterministically. */
function makeDeps(readHeartbeat: ExclusiveWorkerSlotDeps['readHeartbeat']) {
  let nowMs = START;
  const sleep = vi.fn(async (ms: number) => {
    nowMs += ms;
  });
  return { readHeartbeat, sleep, now: () => nowMs };
}

describe('awaitExclusiveWorkerSlot', () => {
  it('starts immediately when no worker has ever reported', async () => {
    const deps = makeDeps(async () => null);
    await expect(awaitExclusiveWorkerSlot(deps)).resolves.toEqual({ status: 'clear' });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('starts immediately when the last heartbeat is already stale', async () => {
    const deps = makeDeps(async () => record(START - 120_000));
    await expect(awaitExclusiveWorkerSlot(deps)).resolves.toEqual({ status: 'clear' });
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('refuses to start while a peer keeps writing its heartbeat', async () => {
    const deps = makeDeps(async () => record(deps.now(), 77));
    await expect(awaitExclusiveWorkerSlot(deps)).resolves.toEqual({ status: 'overlap', pid: 77 });
  });

  it("starts once a killed predecessor's fresh heartbeat ages out", async () => {
    // The OOM/SIGKILL restart: the record is fresh but frozen, so refusing here
    // would crash-loop the replacement exactly when recovery matters.
    const deps = makeDeps(async () => record(START - 1_000));
    await expect(awaitExclusiveWorkerSlot(deps)).resolves.toEqual({ status: 'clear' });
    expect(deps.sleep).toHaveBeenCalled();
    expect(deps.now() - START).toBeLessThanOrEqual(60_000);
  });
});
