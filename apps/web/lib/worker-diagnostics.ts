// Assembles the contract's `worker` diagnostics object — the ONE producer both
// consumers share (`GET /api/diagnostics` and the server-rendered
// `/settings/diagnostics` page). Every source is independently best-effort:
// `null` in the contract consistently means "source unavailable", so one broken
// source (worker never reported, graphile schema missing) degrades its rows,
// never the endpoint.

import {
  getLastProviderPoll,
  getProviderRetriesToday,
  getRecentWorkerEvents,
  getUsageLimits,
  getWorkerQueueStats,
  isWorkerHeartbeatFresh,
  readWorkerHeartbeat,
  type Database,
  type WorkerEvent,
} from '@liedmotif/db';
import { limitWindowStarts, type WorkerDiagnostics } from '@liedmotif/shared';
import { formatTrackDuration } from '@/components/library/library-view-model';
import { formatBinaryBytes } from '@/lib/format-bytes';

export async function getWorkerDiagnostics(
  db: Database,
  now: Date = new Date(),
): Promise<WorkerDiagnostics> {
  // Limits first: the retry window rolls over on the limits' resetTimezone.
  const limits = await getUsageLimits(db).catch(() => null);
  const { dayStart } = limitWindowStarts(now, limits?.resetTimezone ?? 'UTC');
  const [heartbeat, queueStats, lastPoll, retriesToday, events] = await Promise.all([
    readWorkerHeartbeat(db).catch(() => null),
    getWorkerQueueStats(db),
    getLastProviderPoll(db).catch(() => null),
    getProviderRetriesToday(db, dayStart).catch(() => null),
    getRecentWorkerEvents(db).catch((): WorkerEvent[] => []),
  ]);
  return {
    heartbeatAt: heartbeat?.ts ?? null,
    stale: !heartbeat || !isWorkerHeartbeatFresh(heartbeat, now.getTime()),
    state: heartbeat?.state ?? null,
    concurrency: heartbeat?.concurrency ?? null,
    jobsInFlight: queueStats?.jobsInFlight ?? null,
    queuedJobs: queueStats?.queuedJobs ?? null,
    failedJobs: queueStats?.failedJobs ?? null,
    lastProviderPoll: lastPoll
      ? { status: lastPoll.providerStatus, at: lastPoll.at.toISOString() }
      : null,
    retriesToday,
    events: events.map(renderEvent),
  };
}

/** First 8 id chars — enough to correlate with logs, matching the design mock. */
function id8(id: string): string {
  return id.slice(0, 8);
}

/**
 * Render a derived event into its display line. Inputs are ids, enum-ish codes,
 * and numbers only (the repo's no-secrets contract); everything else stays out.
 */
function renderEvent(event: WorkerEvent): WorkerDiagnostics['events'][number] {
  const at = event.at.toISOString();
  switch (event.kind) {
    case 'generation_failed': {
      const parts = [`generate ${id8(event.id)} failed`, event.errorCode ?? 'unknown error'];
      if (event.safeMessage != null) parts.push(event.safeMessage);
      return { at, level: 'warn', message: parts.join(' · ') };
    }
    case 'provider_submitted':
      return { at, level: 'info', message: `generate ${id8(event.id)} submitted` };
    case 'track_downloaded': {
      const parts = [`track ${id8(event.id)} downloaded`];
      if (event.byteSize != null) parts.push(formatBinaryBytes(event.byteSize));
      if (event.durationSeconds != null) parts.push(formatTrackDuration(event.durationSeconds));
      return { at, level: 'info', message: parts.join(' · ') };
    }
  }
}
