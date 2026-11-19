// The one decision behind Instance alerts: which of the three watched conditions
// are firing, and which of those the Admin has not been told about yet. Pure — no
// clock, environment, or I/O — so the anti-spam rule is testable without a
// database. Messages are composed here too, and carry only condition names,
// severities, counts, percentages, and durations: every string leaves the Instance.

import {
  accountedStorageBytes,
  isStorageQuotaReached,
  isWorkerHeartbeatFresh,
  type InstanceAlertCondition,
  type InstanceAlertSeverity,
  type InstanceAlertsState,
  type StorageUsage,
  type WorkerHeartbeat,
} from '@liedmotif/db';
import { storageUsagePercent } from './storage-diagnostics-model';

/** Raw source readings. A null `failedJobs` or `storageUsage` means "source unavailable". */
export interface InstanceAlertsSnapshot {
  heartbeat: WorkerHeartbeat | null;
  failedJobs: number | null;
  storageUsage: StorageUsage | null;
  storageQuotaBytes: number;
  /**
   * The room one music call's final downloads reserve: the worker refuses a new
   * call below it, so that is where new Tracks stop.
   */
  generationReserveBytes: number;
}

interface InstanceAlertThresholds {
  workerHeartbeatStaleAfterMs: number;
  storageWarnPercent: number;
}

const DEFAULT_INSTANCE_ALERT_THRESHOLDS: InstanceAlertThresholds = {
  // Far longer than the 30 s diagnostics window: an ordinary restart or deploy
  // must pass without an alert.
  workerHeartbeatStaleAfterMs: 5 * 60_000,
  storageWarnPercent: 80,
};

export interface InstanceAlertNotification {
  condition: InstanceAlertCondition;
  severity: InstanceAlertSeverity;
  state: 'firing' | 'recovered';
  /** Plain ASCII: the webhook also sends it as a request header. */
  title: string;
  message: string;
  at: string;
  /** On a recovery, when the condition first fired, whatever severities it passed through. */
  since?: string;
}

interface InstanceAlertsEvaluation {
  /** What is firing now, announced before or not. */
  firing: { condition: InstanceAlertCondition; severity: InstanceAlertSeverity; message: string }[];
  notifications: InstanceAlertNotification[];
  nextState: InstanceAlertsState;
}

interface FiringReading {
  severity: InstanceAlertSeverity;
  title: string;
  message: string;
}

/** A firing condition, a clear one, or one whose source is unreadable. */
type ConditionReading = FiringReading | 'clear' | 'unknown';

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** "2 days 3 hours"; the smaller unit drops out at zero. */
function withRemainder(whole: string, count: number, unit: string): string {
  return count > 0 ? `${whole} ${plural(count, unit)}` : whole;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes < 1) return 'less than a minute';
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  if (days > 0) return withRemainder(plural(days, 'day'), hours, 'hour');
  if (hours > 0) return withRemainder(plural(hours, 'hour'), minutes, 'minute');
  return plural(minutes, 'minute');
}

function classifyWorkerHeartbeat(
  heartbeat: WorkerHeartbeat | null,
  nowMs: number,
  staleAfterMs: number,
): ConditionReading {
  if (heartbeat && isWorkerHeartbeatFresh(heartbeat, nowMs, staleAfterMs)) return 'clear';
  // The one source where null is the failure: a worker that never came up.
  const detail = heartbeat
    ? `the worker last reported ${formatDuration(nowMs - Date.parse(heartbeat.ts))} ago`
    : 'the worker has never reported';
  return {
    severity: 'critical',
    title: 'Liedmotif worker is not reporting',
    message: `Worker heartbeat: ${detail}. Generations will not finish.`,
  };
}

function classifyFailedJobs(failedJobs: number | null): ConditionReading {
  if (failedJobs === null) return 'unknown';
  if (failedJobs < 1) return 'clear';
  return {
    severity: 'warning',
    title: 'Liedmotif has permanently failed jobs',
    message: `Failed jobs: ${plural(failedJobs, 'background job')} out of attempts. They will not retry on their own.`,
  };
}

function classifyStorageQuota(
  usage: StorageUsage | null,
  quotaBytes: number,
  reserveBytes: number,
  warnPercent: number,
): ConditionReading {
  if (!usage) return 'unknown';
  const percent = storageUsagePercent(accountedStorageBytes(usage), quotaBytes);
  const used = `${Math.round(percent)}%`;
  if (isStorageQuotaReached(usage, quotaBytes, reserveBytes)) {
    return {
      severity: 'critical',
      title: 'Liedmotif storage quota reached',
      message: `Storage quota: ${used} used. New Tracks are being refused until space is freed or the quota is raised.`,
    };
  }
  if (percent < warnPercent) return 'clear';
  return {
    severity: 'warning',
    title: 'Liedmotif storage quota is nearly full',
    message: `Storage quota: ${used} used. Free some space or raise the quota before new Tracks are refused.`,
  };
}

const RECOVERY_TEXT: Record<InstanceAlertCondition, { title: string; message: string }> = {
  'worker-heartbeat': {
    title: 'Liedmotif worker is reporting again',
    message: 'Worker heartbeat: the worker is reporting again',
  },
  'failed-jobs': {
    title: 'Liedmotif failed jobs cleared',
    message: 'Failed jobs: none left',
  },
  'storage-quota': {
    title: 'Liedmotif storage quota has room again',
    message: 'Storage quota: back under the warning level',
  },
};

/**
 * Diff the snapshot against what was last announced. Firing and unannounced, or
 * firing at a different severity, notifies; announced and no longer firing
 * notifies a recovery. An unreadable source keeps whatever was announced: unknown
 * is neither "broken" nor "recovered". The state changes only when a notification
 * goes out.
 */
export function evaluateInstanceAlerts(
  snapshot: InstanceAlertsSnapshot,
  previous: InstanceAlertsState,
  nowMs: number,
  thresholds: InstanceAlertThresholds = DEFAULT_INSTANCE_ALERT_THRESHOLDS,
): InstanceAlertsEvaluation {
  const at = new Date(nowMs).toISOString();
  const readings: [InstanceAlertCondition, ConditionReading][] = [
    [
      'worker-heartbeat',
      classifyWorkerHeartbeat(snapshot.heartbeat, nowMs, thresholds.workerHeartbeatStaleAfterMs),
    ],
    ['failed-jobs', classifyFailedJobs(snapshot.failedJobs)],
    [
      'storage-quota',
      classifyStorageQuota(
        snapshot.storageUsage,
        snapshot.storageQuotaBytes,
        snapshot.generationReserveBytes,
        thresholds.storageWarnPercent,
      ),
    ],
  ];

  const nextState: InstanceAlertsState = { ...previous };
  const firing: InstanceAlertsEvaluation['firing'] = [];
  const notifications: InstanceAlertNotification[] = [];
  for (const [condition, reading] of readings) {
    const announced = previous[condition];
    if (reading === 'unknown') continue;
    if (reading === 'clear') {
      if (!announced) continue;
      delete nextState[condition];
      const { title, message } = RECOVERY_TEXT[condition];
      const lasted = formatDuration(nowMs - Date.parse(announced.since));
      notifications.push({
        condition,
        severity: announced.severity,
        state: 'recovered',
        title,
        message: `${message} after ${lasted}.`,
        at,
        since: announced.since,
      });
      continue;
    }
    firing.push({ condition, severity: reading.severity, message: reading.message });
    if (announced?.severity === reading.severity) continue;
    nextState[condition] = { severity: reading.severity, since: announced?.since ?? at };
    notifications.push({ condition, state: 'firing', at, ...reading });
  }
  return { firing, notifications, nextState };
}
