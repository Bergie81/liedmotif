// Worker heartbeat over `app_settings`: the worker's file heartbeat feeds only
// the Docker healthcheck, so the worker ALSO upserts this record on the same
// interval — the one channel the web process can read. Single worker: one
// row, last writer wins.

import type { Database } from '../client';
import type { DbOrTx } from '../transactions';
import { APP_SETTINGS_KEYS } from '../schema';
import type { WorkerHeartbeat } from '../schema/types';
import { readSetting, writeSetting } from '../setup/settings';

/**
 * Two 15 s heartbeat intervals, so a single missed beat already reads as stale.
 * Beyond this the worker is treated as down —
 * `degraded`, not `unavailable`: a worker that WAS reporting and stopped is a
 * problem to surface, unlike one that never existed.
 */
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 30_000;

export type WorkerHeartbeatHealth = 'healthy' | 'degraded' | 'unavailable';

/** Upsert the worker's liveness report (called by the worker every interval). */
export async function writeWorkerHeartbeat(db: Database, record: WorkerHeartbeat): Promise<void> {
  await writeSetting(db, APP_SETTINGS_KEYS.workerHeartbeat, record);
}

/** The last reported heartbeat, or `null` when the worker has never reported. */
export async function readWorkerHeartbeat(db: DbOrTx): Promise<WorkerHeartbeat | null> {
  return readSetting<WorkerHeartbeat>(db, APP_SETTINGS_KEYS.workerHeartbeat);
}

/** True while the record's `ts` is within the stale window of `nowMs`. */
export function isWorkerHeartbeatFresh(
  record: WorkerHeartbeat,
  nowMs: number,
  staleAfterMs: number = WORKER_HEARTBEAT_STALE_AFTER_MS,
): boolean {
  return nowMs - Date.parse(record.ts) <= staleAfterMs;
}

/**
 * Presentation health: fresh + `ready` is the only healthy state. A fresh
 * `starting`/`degraded` worker and a stale one both warn; `unavailable` is
 * reserved for a heartbeat that was never written.
 */
export function workerHeartbeatHealth(
  record: WorkerHeartbeat | null,
  nowMs: number,
  staleAfterMs: number = WORKER_HEARTBEAT_STALE_AFTER_MS,
): WorkerHeartbeatHealth {
  if (!record) return 'unavailable';
  if (!isWorkerHeartbeatFresh(record, nowMs, staleAfterMs)) return 'degraded';
  return record.state === 'ready' ? 'healthy' : 'degraded';
}
