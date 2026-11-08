// Presentation model for the diagnostics Worker section. Client-safe (pure
// functions over the contract's worker object) so the live card can re-derive
// every row after each poll with the same logic the server render used.

import type { WorkerDiagnostics } from '@liedmotif/shared';
import type { DiagnosticHealth } from './storage-diagnostics-model';

/**
 * Contract-shape mirror of the repo-side heartbeat health: healthy only for a
 * fresh `ready` worker; a worker that reported and went stale (or is not ready)
 * warns; one that never reported is unavailable.
 */
export function workerHealth(
  worker: Pick<WorkerDiagnostics, 'heartbeatAt' | 'stale' | 'state'>,
): DiagnosticHealth {
  if (!worker.heartbeatAt) return 'unavailable';
  if (worker.stale || worker.state !== 'ready') return 'degraded';
  return 'healthy';
}

/** Seconds-granular relative age (the heartbeat beats every ~10 s). */
export function formatSecondsAgo(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1_000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} hr ago`;
}

export interface WorkerRow {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'muted';
}

/** What a row reads, before its fixed label is attached. */
type WorkerRowValue = Pick<WorkerRow, 'value' | 'tone'>;

function heartbeatValue(worker: WorkerDiagnostics, nowMs: number): WorkerRowValue {
  if (!worker.heartbeatAt) return { value: 'Unavailable', tone: 'muted' };
  const ago = formatSecondsAgo(worker.heartbeatAt, nowMs);
  if (worker.stale) return { value: `${ago} · stale`, tone: 'warn' };
  return { value: ago, tone: 'ok' };
}

function jobsInFlightValue(worker: WorkerDiagnostics): WorkerRowValue {
  if (worker.jobsInFlight == null) return { value: 'Unavailable', tone: 'muted' };
  if (worker.concurrency == null) return { value: `${worker.jobsInFlight}`, tone: 'muted' };
  return { value: `${worker.jobsInFlight} of ${worker.concurrency} slots`, tone: 'muted' };
}

function queuedJobsValue(worker: WorkerDiagnostics): WorkerRowValue {
  if (worker.queuedJobs == null) return { value: 'Unavailable', tone: 'muted' };
  if (worker.failedJobs) {
    return { value: `${worker.queuedJobs} · ${worker.failedJobs} failed`, tone: 'warn' };
  }
  return { value: `${worker.queuedJobs}`, tone: 'muted' };
}

/** The five Worker-card rows; each falls back independently ("null = source unavailable"). */
export function workerRows(worker: WorkerDiagnostics, nowMs: number): WorkerRow[] {
  return [
    { label: 'Last heartbeat', ...heartbeatValue(worker, nowMs) },
    { label: 'Jobs in flight', ...jobsInFlightValue(worker) },
    { label: 'Queued jobs', ...queuedJobsValue(worker) },
    {
      label: 'Last provider poll',
      // Null here usually means no job ever reached the provider (fresh
      // instance), so "None yet" beats an alarming "Unavailable".
      value: worker.lastProviderPoll
        ? `${worker.lastProviderPoll.status} · ${formatSecondsAgo(worker.lastProviderPoll.at, nowMs)}`
        : 'None yet',
      tone: 'muted',
    },
    {
      // `retriesToday` counts provider poll ATTEMPTS, which `maxRetriesPerJob`
      // does not bound: that control caps failure retries, while a poll paces
      // free status reads on its own budget. Pairing the two numbers here would
      // read as a ceiling.
      label: 'Provider polls today',
      value: worker.retriesToday == null ? 'Unavailable' : String(worker.retriesToday),
      tone: 'muted',
    },
  ];
}

export interface WorkerEventRow {
  time: string;
  message: string;
  warn: boolean;
}

/** Event lines with a local `dd/mm hh:mm:ss` stamp, newest first (server order). */
export function workerEventRows(worker: Pick<WorkerDiagnostics, 'events'>): WorkerEventRow[] {
  return worker.events.map((event) => {
    const at = new Date(event.at);
    // The feed can span days (the sources are capped, not time-boxed), so the
    // day matters; the year would only widen every line for no signal.
    const date = at.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
    return {
      time: `${date} ${at.toLocaleTimeString('en-GB', { hour12: false })}`,
      message: event.message,
      warn: event.level === 'warn',
    };
  });
}
