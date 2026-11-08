import { describe, expect, it } from 'vitest';
import type { WorkerDiagnostics } from '@liedmotif/shared';
import {
  formatSecondsAgo,
  workerEventRows,
  workerHealth,
  workerRows,
} from './worker-diagnostics-model';

const NOW = Date.parse('2026-07-30T12:00:08.000Z');

function worker(overrides: Partial<WorkerDiagnostics> = {}): WorkerDiagnostics {
  return {
    heartbeatAt: '2026-07-30T12:00:00.000Z',
    stale: false,
    state: 'ready',
    concurrency: 2,
    jobsInFlight: 1,
    queuedJobs: 2,
    failedJobs: 0,
    lastProviderPoll: { status: 'FIRST_SUCCESS', at: '2026-07-30T12:00:04.000Z' },
    retriesToday: 1,
    events: [],
    ...overrides,
  };
}

describe('workerHealth', () => {
  it('is healthy only for a fresh ready worker', () => {
    expect(workerHealth(worker())).toBe('healthy');
  });

  it('degrades on staleness or a non-ready state', () => {
    expect(workerHealth(worker({ stale: true }))).toBe('degraded');
    expect(workerHealth(worker({ state: 'degraded' }))).toBe('degraded');
    expect(workerHealth(worker({ state: 'starting' }))).toBe('degraded');
  });

  it('is unavailable when the worker has never reported', () => {
    expect(workerHealth(worker({ heartbeatAt: null, state: null, stale: true }))).toBe(
      'unavailable',
    );
  });

  it('agrees with the repo-side workerHeartbeatHealth for every record shape', async () => {
    // Two derivations exist on purpose (the client works from the contract, the
    // repo from the stored record); this pins them together so they cannot drift.
    const { workerHeartbeatHealth, WORKER_HEARTBEAT_STALE_AFTER_MS } =
      await import('@liedmotif/db');
    const ts = '2026-07-30T12:00:00.000Z';
    for (const state of ['starting', 'ready', 'degraded'] as const) {
      for (const ageMs of [0, WORKER_HEARTBEAT_STALE_AFTER_MS + 1]) {
        const record = { ts, pid: 1, state, concurrency: 2, startedAt: ts };
        const nowMs = Date.parse(ts) + ageMs;
        const stale = ageMs > WORKER_HEARTBEAT_STALE_AFTER_MS;
        expect(workerHealth(worker({ heartbeatAt: ts, stale, state }))).toBe(
          workerHeartbeatHealth(record, nowMs),
        );
      }
    }
    expect(workerHealth(worker({ heartbeatAt: null, stale: true, state: null }))).toBe(
      workerHeartbeatHealth(null, Date.parse(ts)),
    );
  });
});

describe('formatSecondsAgo', () => {
  it('scales from seconds through minutes to hours', () => {
    expect(formatSecondsAgo('2026-07-30T12:00:00.000Z', NOW)).toBe('8 s ago');
    expect(formatSecondsAgo('2026-07-30T11:58:08.000Z', NOW)).toBe('2 min ago');
    expect(formatSecondsAgo('2026-07-30T09:00:08.000Z', NOW)).toBe('3 hr ago');
  });

  it('never shows a negative age', () => {
    expect(formatSecondsAgo('2026-07-30T12:00:09.000Z', NOW)).toBe('0 s ago');
  });
});

describe('workerRows', () => {
  it('renders the five live rows from a healthy worker', () => {
    expect(workerRows(worker(), NOW)).toEqual([
      { label: 'Last heartbeat', value: '8 s ago', tone: 'ok' },
      { label: 'Jobs in flight', value: '1 of 2 slots', tone: 'muted' },
      { label: 'Queued jobs', value: '2', tone: 'muted' },
      { label: 'Last provider poll', value: 'FIRST_SUCCESS · 4 s ago', tone: 'muted' },
      { label: 'Provider polls today', value: '1', tone: 'muted' },
    ]);
  });

  it('warns on the heartbeat row when the worker went stale', () => {
    const rows = workerRows(worker({ stale: true }), NOW);
    expect(rows[0]).toEqual({ label: 'Last heartbeat', value: '8 s ago · stale', tone: 'warn' });
  });

  it('surfaces permanently failed jobs on the queued row with a warn tone', () => {
    const rows = workerRows(worker({ failedJobs: 1 }), NOW);
    expect(rows[2]).toEqual({ label: 'Queued jobs', value: '2 · 1 failed', tone: 'warn' });
  });

  it('falls back per row when a source is unavailable', () => {
    const rows = workerRows(
      worker({
        heartbeatAt: null,
        state: null,
        stale: true,
        concurrency: null,
        jobsInFlight: null,
        queuedJobs: null,
        failedJobs: null,
        lastProviderPoll: null,
        retriesToday: null,
      }),
      NOW,
    );
    expect(rows).toEqual([
      { label: 'Last heartbeat', value: 'Unavailable', tone: 'muted' },
      { label: 'Jobs in flight', value: 'Unavailable', tone: 'muted' },
      { label: 'Queued jobs', value: 'Unavailable', tone: 'muted' },
      { label: 'Last provider poll', value: 'None yet', tone: 'muted' },
      { label: 'Provider polls today', value: 'Unavailable', tone: 'muted' },
    ]);
  });

  it('shows a bare in-flight count when the slot total is unknown', () => {
    const rows = workerRows(worker({ concurrency: null }), NOW);
    expect(rows[1]).toEqual({ label: 'Jobs in flight', value: '1', tone: 'muted' });
  });
});

describe('workerEventRows', () => {
  it('maps events to date + time-of-day lines, flagging warnings', () => {
    const rows = workerEventRows(
      worker({
        events: [
          { at: '2026-07-30T12:03:00.000Z', level: 'warn', message: 'generate a1b2c3d4 failed' },
          { at: '2026-07-30T12:01:00.000Z', level: 'info', message: 'track b2c3d4e5 downloaded' },
        ],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ message: 'generate a1b2c3d4 failed', warn: true });
    expect(rows[0]!.time).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(rows[1]).toMatchObject({ message: 'track b2c3d4e5 downloaded', warn: false });
  });
});
