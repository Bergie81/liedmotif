import { describe, expect, it } from 'vitest';
import type { InstanceAlertsState, StorageUsage, WorkerHeartbeat } from '@liedmotif/db';
import {
  evaluateInstanceAlerts,
  type InstanceAlertsSnapshot,
  type InstanceAlertNotification,
} from './instance-alerts-model';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const MINUTE = 60_000;
const MIB = 1024 ** 2;
const QUOTA = 1000 * MIB;

function heartbeatAged(ageMs: number): WorkerHeartbeat {
  return {
    ts: new Date(NOW - ageMs).toISOString(),
    pid: 1,
    state: 'ready',
    concurrency: 2,
    startedAt: new Date(NOW - ageMs - 60 * MINUTE).toISOString(),
  };
}

function usage(totalBytes: number, reservedBytes?: number): StorageUsage {
  return { totalBytes, reservedBytes, measuredAt: new Date(NOW - MINUTE).toISOString() };
}

const HEALTHY: InstanceAlertsSnapshot = {
  heartbeat: heartbeatAged(5_000),
  failedJobs: 0,
  storageUsage: usage(0),
  storageQuotaBytes: QUOTA,
};

function evaluate(snapshot: Partial<InstanceAlertsSnapshot>, previous: InstanceAlertsState = {}) {
  return evaluateInstanceAlerts({ ...HEALTHY, ...snapshot }, previous, NOW);
}

function only(notifications: InstanceAlertNotification[]): InstanceAlertNotification {
  expect(notifications).toHaveLength(1);
  return notifications[0]!;
}

describe('worker-heartbeat', () => {
  it('fires nothing for a fresh heartbeat', () => {
    expect(evaluate({ heartbeat: heartbeatAged(5_000) }).notifications).toEqual([]);
  });

  it('fires critical when the worker never reported, and says so', () => {
    const fired = only(evaluate({ heartbeat: null }).notifications);
    expect(fired).toMatchObject({
      condition: 'worker-heartbeat',
      severity: 'critical',
      state: 'firing',
    });
    expect(fired.message).toMatch(/worker heartbeat/i);
    expect(fired.message).toMatch(/never reported/i);
  });

  it('fires critical when the heartbeat is older than the alert window, naming its age', () => {
    const fired = only(evaluate({ heartbeat: heartbeatAged(12 * MINUTE) }).notifications);
    expect(fired).toMatchObject({ condition: 'worker-heartbeat', severity: 'critical' });
    expect(fired.message).toMatch(/12 minutes ago/);
  });

  it('stays quiet through an ordinary restart: past the 30 s diagnostics window, inside the alert window', () => {
    expect(evaluate({ heartbeat: heartbeatAged(45_000) }).notifications).toEqual([]);
    expect(evaluate({ heartbeat: heartbeatAged(4 * MINUTE) }).notifications).toEqual([]);
  });

  it('takes its window from the trailing thresholds', () => {
    const { notifications } = evaluateInstanceAlerts(
      { ...HEALTHY, heartbeat: heartbeatAged(90_000) },
      {},
      NOW,
      { workerHeartbeatStaleAfterMs: MINUTE, storageWarnPercent: 50 },
    );
    expect(only(notifications).condition).toBe('worker-heartbeat');
  });
});

describe('failed-jobs', () => {
  it('fires nothing at zero', () => {
    expect(evaluate({ failedJobs: 0 }).notifications).toEqual([]);
  });

  it('fires warning at one or more, carrying the count', () => {
    const fired = only(evaluate({ failedJobs: 3 }).notifications);
    expect(fired).toMatchObject({ condition: 'failed-jobs', severity: 'warning', state: 'firing' });
    expect(fired.message).toMatch(/failed jobs/i);
    expect(fired.message).toContain('3');
  });

  it('fires nothing when the source is unavailable', () => {
    expect(evaluate({ failedJobs: null }).notifications).toEqual([]);
  });
});

describe('storage-quota', () => {
  it('fires nothing below the warn ratio', () => {
    expect(evaluate({ storageUsage: usage(100 * MIB) }).notifications).toEqual([]);
  });

  it('fires warning at the warn ratio, carrying the percentage', () => {
    const fired = only(evaluate({ storageUsage: usage(800 * MIB) }).notifications);
    expect(fired).toMatchObject({ condition: 'storage-quota', severity: 'warning' });
    expect(fired.message).toMatch(/storage quota/i);
    expect(fired.message).toContain('80%');
  });

  it('counts reserved bytes toward the warn ratio', () => {
    const fired = only(evaluate({ storageUsage: usage(700 * MIB, 100 * MIB) }).notifications);
    expect(fired).toMatchObject({ condition: 'storage-quota', severity: 'warning' });
  });

  it('goes critical exactly when a Track of 64 MiB would be refused, not at the quota line', () => {
    const roomForOneTrack = QUOTA - 64 * MIB;
    expect(only(evaluate({ storageUsage: usage(roomForOneTrack) }).notifications).severity).toBe(
      'warning',
    );
    expect(
      only(evaluate({ storageUsage: usage(roomForOneTrack + 1) }).notifications).severity,
    ).toBe('critical');
  });

  it('fires nothing when usage has never been measured', () => {
    expect(evaluate({ storageUsage: null }).notifications).toEqual([]);
  });

  it('treats a zero quota as the admission gate does: every write refused', () => {
    expect(
      only(evaluate({ storageUsage: usage(0), storageQuotaBytes: 0 }).notifications).severity,
    ).toBe('critical');
  });
});

describe('state transitions', () => {
  const firing = { heartbeat: null };

  it('records a first firing in the next state with the moment it started', () => {
    const { notifications, nextState } = evaluate(firing);
    expect(notifications).toHaveLength(1);
    expect(nextState).toEqual({
      'worker-heartbeat': { severity: 'critical', since: new Date(NOW).toISOString() },
    });
  });

  it('sends nothing for an unchanged repeat, keeping the original since', () => {
    const previous: InstanceAlertsState = {
      'worker-heartbeat': { severity: 'critical', since: '2026-11-01T00:00:00.000Z' },
    };
    const { notifications, nextState } = evaluate(firing, previous);
    expect(notifications).toEqual([]);
    expect(nextState).toEqual(previous);
  });

  it('notifies again when warning escalates to critical, keeping the original since', () => {
    const previous: InstanceAlertsState = {
      'storage-quota': { severity: 'warning', since: '2026-11-01T00:00:00.000Z' },
    };
    const { notifications, nextState } = evaluate({ storageUsage: usage(QUOTA) }, previous);
    expect(only(notifications)).toMatchObject({
      condition: 'storage-quota',
      severity: 'critical',
      state: 'firing',
    });
    expect(nextState['storage-quota']).toEqual({
      severity: 'critical',
      since: '2026-11-01T00:00:00.000Z',
    });
  });

  it('reports the whole incident on recovery: three days at warning, ten minutes at critical', () => {
    const start = NOW - 3 * 24 * 60 * MINUTE;
    const atWarning: InstanceAlertsState = {
      'storage-quota': { severity: 'warning', since: new Date(start).toISOString() },
    };
    const escalated = evaluateInstanceAlerts(
      { ...HEALTHY, storageUsage: usage(QUOTA) },
      atWarning,
      NOW - 10 * MINUTE,
    );

    const recovery = only(evaluate({}, escalated.nextState).notifications);
    expect(recovery).toMatchObject({ severity: 'critical', state: 'recovered' });
    expect(recovery.since).toBe(new Date(start).toISOString());
    expect(recovery.message).toMatch(/after 3 days\./);
  });

  it('does not notify when a count grows at the same severity', () => {
    const previous: InstanceAlertsState = {
      'failed-jobs': { severity: 'warning', since: '2026-11-01T00:00:00.000Z' },
    };
    expect(evaluate({ failedJobs: 50 }, previous).notifications).toEqual([]);
  });

  it('notifies recovered once when a condition clears, saying how long it fired', () => {
    const since = new Date(NOW - 90 * MINUTE).toISOString();
    const previous: InstanceAlertsState = { 'worker-heartbeat': { severity: 'critical', since } };
    const recovered = evaluate({}, previous);
    expect(only(recovered.notifications)).toMatchObject({
      condition: 'worker-heartbeat',
      severity: 'critical',
      state: 'recovered',
      since,
    });
    expect(recovered.notifications[0]!.message).toMatch(/1 hour 30 minutes/);
    expect(recovered.nextState).toEqual({});
    expect(evaluate({}, recovered.nextState).notifications).toEqual([]);
  });

  it('notifies again when a cleared condition re-fires', () => {
    const cleared = evaluate(
      {},
      { 'failed-jobs': { severity: 'warning', since: '2026-11-01T00:00:00.000Z' } },
    );
    const refired = evaluate({ failedJobs: 1 }, cleared.nextState);
    expect(only(refired.notifications)).toMatchObject({
      condition: 'failed-jobs',
      state: 'firing',
    });
  });

  it('never announces a recovery from a source it cannot read', () => {
    const previous: InstanceAlertsState = {
      'failed-jobs': { severity: 'warning', since: '2026-11-01T00:00:00.000Z' },
      'storage-quota': { severity: 'critical', since: '2026-11-02T00:00:00.000Z' },
    };
    const {
      notifications,
      nextState,
      firing: stillFiring,
    } = evaluate({ failedJobs: null, storageUsage: null }, previous);
    expect(notifications).toEqual([]);
    expect(nextState).toEqual(previous);
    expect(stillFiring).toEqual([]);
  });

  it('reports what is firing now, whether or not it changed', () => {
    const previous: InstanceAlertsState = {
      'failed-jobs': { severity: 'warning', since: '2026-11-01T00:00:00.000Z' },
    };
    expect(evaluate({ failedJobs: 2, heartbeat: null }, previous).firing).toEqual([
      { condition: 'worker-heartbeat', severity: 'critical', message: expect.any(String) },
      {
        condition: 'failed-jobs',
        severity: 'warning',
        message: expect.stringContaining('2 background jobs'),
      },
    ]);
  });
});

describe('message content', () => {
  const everyNotification = [
    ...evaluate({ heartbeat: null, failedJobs: 4, storageUsage: usage(QUOTA) }).notifications,
    ...evaluate(
      {},
      {
        'worker-heartbeat': { severity: 'critical', since: '2026-11-03T00:00:00.000Z' },
        'failed-jobs': { severity: 'warning', since: '2026-11-03T00:00:00.000Z' },
        'storage-quota': { severity: 'warning', since: '2026-11-03T00:00:00.000Z' },
      },
    ).notifications,
  ];

  it('carries no URL, key, or secret-shaped substring', () => {
    expect(everyNotification).toHaveLength(6);
    for (const notification of everyNotification) {
      const text = JSON.stringify(notification);
      expect(text).not.toMatch(/http|sk-|token|password|secret|\.mp3|api[-_ ]?key/i);
    }
  });

  it('keeps titles ASCII, because the webhook sends them as a request header', () => {
    for (const { title } of everyNotification) {
      expect(title).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});
