import { describe, expect, it } from 'vitest';
import type { BackupStatusFile } from '@liedmotif/shared';
import { BACKUP_STATUS_STALE_AFTER_MS, backupServiceState } from './backup-status-model';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

function status(overrides: Partial<BackupStatusFile> = {}): BackupStatusFile {
  return {
    checkedAt: '2026-11-04T11:59:30Z',
    nextRunAt: '2026-11-08T03:00:00Z',
    running: null,
    lastAttempt: {
      startedAt: '2026-11-01T03:00:20Z',
      finishedAt: '2026-11-01T03:04:00Z',
      ok: true,
    },
    lastSuccessAt: '2026-11-01T03:04:00Z',
    overdue: false,
    diskBytes: 1_000,
    freeBytes: 9_000,
    encrypted: true,
    ...overrides,
  };
}

function state(
  file: BackupStatusFile | null,
  opts: { requestedAt?: string | null; nowMs?: number } = {},
) {
  return backupServiceState({
    status: file,
    requestedAt: opts.requestedAt ?? null,
    nowMs: opts.nowMs ?? NOW,
  });
}

describe('backupServiceState', () => {
  it('is healthy when the last success covers the last slot', () => {
    expect(state(status())).toBe('healthy');
  });

  it('is not-running without a status file', () => {
    expect(state(null)).toBe('not-running');
  });

  it('counts the sidecar alive up to exactly three minutes after its last check', () => {
    const checkedAtMs = Date.parse('2026-11-04T11:59:30Z');
    expect(BACKUP_STATUS_STALE_AFTER_MS).toBe(180_000);
    expect(state(status(), { nowMs: checkedAtMs + 180_000 })).toBe('healthy');
    expect(state(status(), { nowMs: checkedAtMs + 180_001 })).toBe('not-running');
  });

  it('reports a stale sidecar as not-running even when its last report says running', () => {
    const file = status({ running: { startedAt: '2026-11-04T11:00:00Z', trigger: 'manual' } });
    expect(state(file, { nowMs: Date.parse('2026-11-04T12:10:00Z') })).toBe('not-running');
  });

  it('is running while a backup is in progress, whatever came before', () => {
    const file = status({
      running: { startedAt: '2026-11-04T11:59:00Z', trigger: 'manual' },
      lastAttempt: {
        startedAt: '2026-11-03T03:00:00Z',
        finishedAt: '2026-11-03T03:00:05Z',
        ok: false,
        error: 'dump-failed',
      },
    });
    expect(state(file, { requestedAt: '2026-11-04T11:59:30.000Z' })).toBe('running');
  });

  it('is requested while Back up now is newer than the last attempt, even after a failure', () => {
    expect(state(status(), { requestedAt: '2026-11-04T11:58:00.000Z' })).toBe('requested');
    const failed = status({
      lastAttempt: {
        startedAt: '2026-11-04T11:00:00Z',
        finishedAt: '2026-11-04T11:00:05Z',
        ok: false,
        error: 'low-disk',
      },
    });
    expect(state(failed, { requestedAt: '2026-11-04T11:58:00.000Z' })).toBe('requested');
  });

  it('is requested before the first attempt ever, and not once an attempt has started after it', () => {
    expect(
      state(status({ lastAttempt: null, lastSuccessAt: null }), {
        requestedAt: '2026-11-04T11:58:00.000Z',
      }),
    ).toBe('requested');
    expect(state(status(), { requestedAt: '2026-11-01T03:00:10.000Z' })).toBe('healthy');
  });

  it('is failing when the last attempt failed', () => {
    const file = status({
      lastAttempt: {
        startedAt: '2026-11-04T11:00:00Z',
        finishedAt: '2026-11-04T11:00:05Z',
        ok: false,
        error: 'database-unreachable',
      },
      retryAt: '2026-11-04T12:05:00Z',
    });
    expect(state(file)).toBe('failing');
  });

  it('is overdue when the sidecar reports the last scheduled slot missed', () => {
    expect(state(status({ overdue: true }))).toBe('overdue');
  });

  it('reports a failure ahead of the missed slot it leaves behind', () => {
    const file = status({
      overdue: true,
      lastAttempt: {
        startedAt: '2026-11-04T11:00:00Z',
        finishedAt: '2026-11-04T11:00:05Z',
        ok: false,
        error: 'dump-failed',
      },
    });
    expect(state(file)).toBe('failing');
  });
});
