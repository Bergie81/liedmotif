import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEARTBEAT_PATH,
  heartbeatPayload,
  isHeartbeatFresh,
  resolveHeartbeatPath,
} from '../src/heartbeat';

describe('resolveHeartbeatPath', () => {
  it('defaults when the env var is absent or blank', () => {
    expect(resolveHeartbeatPath({})).toBe(DEFAULT_HEARTBEAT_PATH);
    expect(resolveHeartbeatPath({ WORKER_HEARTBEAT_PATH: '   ' })).toBe(DEFAULT_HEARTBEAT_PATH);
  });

  it('uses the configured path when set', () => {
    expect(resolveHeartbeatPath({ WORKER_HEARTBEAT_PATH: '/data/hb' })).toBe('/data/hb');
  });
});

describe('heartbeatPayload', () => {
  it('serializes an ISO timestamp, pid, and the readiness state', () => {
    const payload = JSON.parse(heartbeatPayload('ready', new Date('2026-01-01T00:00:00.000Z'), 42));
    expect(payload).toEqual({ ts: '2026-01-01T00:00:00.000Z', pid: 42, state: 'ready' });
  });

  it('carries the not-ready states the healthcheck must reject', () => {
    expect(JSON.parse(heartbeatPayload('starting', new Date(), 1)).state).toBe('starting');
    expect(JSON.parse(heartbeatPayload('degraded', new Date(), 1)).state).toBe('degraded');
  });
});

describe('isHeartbeatFresh', () => {
  it('is fresh within the window and stale beyond it', () => {
    const now = 100_000;
    expect(isHeartbeatFresh(now - 5_000, now, 30_000)).toBe(true);
    expect(isHeartbeatFresh(now - 45_000, now, 30_000)).toBe(false);
  });
});
