import { describe, expect, it } from 'vitest';
import { classifyAutoStop, type AutoStopSessionInput } from './auto-stop';

const NOW = new Date('2026-06-29T12:00:00Z');
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

const base: AutoStopSessionInput = {
  status: 'active',
  startedAt: minutesAgo(5),
  lastResumedAt: null,
  lastPlaybackReportAt: minutesAgo(1),
  idleAutoStopAfterMinutes: 15,
};

describe('classifyAutoStop', () => {
  it('leaves a healthy, recently-playing session active', () => {
    expect(classifyAutoStop(base, NOW)).toBeNull();
  });

  it('stops an idle session with endReason=idle_timeout', () => {
    const session = { ...base, startedAt: minutesAgo(30), lastPlaybackReportAt: minutesAgo(20) };
    expect(classifyAutoStop(session, NOW)).toEqual({ endReason: 'idle_timeout' });
  });

  it('uses the active-span start as the idle baseline when no playback was reported', () => {
    const session = { ...base, startedAt: minutesAgo(20), lastPlaybackReportAt: null };
    expect(classifyAutoStop(session, NOW)).toEqual({ endReason: 'idle_timeout' });
  });

  it('a long-running session that is still playing stays active', () => {
    const session = { ...base, startedAt: minutesAgo(120), lastResumedAt: minutesAgo(10) };
    expect(classifyAutoStop(session, NOW)).toBeNull();
  });

  it('a just-resumed session is not stopped on the report from its previous listen', () => {
    const session = {
      ...base,
      startedAt: minutesAgo(240),
      lastResumedAt: minutesAgo(1),
      lastPlaybackReportAt: minutesAgo(180),
    };
    expect(classifyAutoStop(session, NOW)).toBeNull();
  });

  it('never auto-stops an already-stopped session', () => {
    const session = { ...base, status: 'stopped' as const, lastPlaybackReportAt: minutesAgo(120) };
    expect(classifyAutoStop(session, NOW)).toBeNull();
  });
});
