// Liveness + readiness heartbeat. The worker has no HTTP server, so
// its Docker healthcheck reads this file: freshness proves the process is alive,
// and `state` says whether it can actually run jobs — a degraded heartbeat-only
// process (no `DATABASE_URL`) is alive but must never report healthy. Kept
// side-effect-free except for `writeHeartbeat` so the payload logic is unit-tested.

import { writeFile } from 'node:fs/promises';

export const DEFAULT_HEARTBEAT_PATH = '/tmp/liedmotif-worker-heartbeat';

/** Resolve the heartbeat path from `WORKER_HEARTBEAT_PATH`, else the default. */
export function resolveHeartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WORKER_HEARTBEAT_PATH?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_HEARTBEAT_PATH;
}

/**
 * Readiness, distinct from liveness: `starting` = boot underway, `ready` = the
 * database is reachable and the Graphile runner is started, `degraded` = alive
 * but unable to run jobs. Only `ready` passes the healthcheck.
 */
export type WorkerReadiness = 'starting' | 'ready' | 'degraded';

export interface HeartbeatRecord {
  ts: string;
  pid: number;
  state: WorkerReadiness;
}

export function heartbeatPayload(
  state: WorkerReadiness,
  now: Date = new Date(),
  pid: number = process.pid,
): string {
  const record: HeartbeatRecord = { ts: now.toISOString(), pid, state };
  return JSON.stringify(record);
}

export async function writeHeartbeat(path: string, state: WorkerReadiness): Promise<void> {
  await writeFile(path, heartbeatPayload(state), 'utf8');
}

/** True when a heartbeat with the given mtime is within `maxAgeMs` of now. */
export function isHeartbeatFresh(mtimeMs: number, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - mtimeMs <= maxAgeMs;
}
