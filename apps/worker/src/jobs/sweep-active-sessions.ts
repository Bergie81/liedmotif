// `sweep-active-sessions` recurring job. A low-frequency safety-net sweep:
// for every ACTIVE session it first auto-stops the idle ones (Stopped
// sessions are never returned by the query, so they are excluded), then enqueues
// `ensure-session-buffer` for the survivors — only non-idle active sessions get a
// buffer top-up. The buffer controller itself decides whether to actually
// generate (Session Repeat / limits / manual), so the sweep stays simple.

import type { Database } from '@liedmotif/db';
import { getUsageLimits, listActiveSessionsForSweep, stopSessionFromWorker } from '@liedmotif/db';
import { mapWithConcurrency } from '@liedmotif/shared';
import type { Task } from 'graphile-worker';
import { classifyAutoStop } from '../controller/auto-stop';
import { enqueueBufferRefill } from './enqueue';

export interface SweepActiveSessionsDeps {
  db: Database;
  now?: Date;
  /** Enqueue a buffer top-up for one session (Graphile `addJob` in production). */
  enqueueBuffer: (sessionId: string) => Promise<void>;
}

export interface SweepActiveSessionsResult {
  stopped: Array<{ sessionId: string; endReason: 'idle_timeout' }>;
  buffered: string[];
}

export async function runSweepActiveSessions(
  deps: SweepActiveSessionsDeps,
): Promise<SweepActiveSessionsResult> {
  const now = deps.now ?? new Date();
  const sessions = await listActiveSessionsForSweep(deps.db);
  // The idle window is the instance setting (Settings → Limits), read per pass
  // so a change applies to Sessions already running.
  const { idleAutoStopAfterMinutes } = await getUsageLimits(deps.db);
  const result: SweepActiveSessionsResult = { stopped: [], buffered: [] };

  for (const session of sessions) {
    const decision = classifyAutoStop(
      {
        status: 'active',
        startedAt: session.startedAt,
        lastResumedAt: session.lastResumedAt,
        lastPlaybackReportAt: session.lastPlaybackReportAt,
        idleAutoStopAfterMinutes,
      },
      now,
    );

    if (decision) {
      const { stopped } = await stopSessionFromWorker(deps.db, {
        sessionId: session.sessionId,
        endReason: decision.endReason,
        now,
      });
      if (stopped)
        result.stopped.push({ sessionId: session.sessionId, endReason: decision.endReason });
      continue; // a stopped session is never topped up
    }

    result.buffered.push(session.sessionId);
  }

  // Batched (bounded) instead of one awaited round trip per session; each
  // enqueue is already deduped by its stable `buffer:<sessionId>` job key.
  await mapWithConcurrency(result.buffered, 8, (sessionId) => deps.enqueueBuffer(sessionId));

  return result;
}

/** Bind to Graphile, serializing `ensure-session-buffer` per session by job key. */
export function createSweepActiveSessionsTask(deps: { db: Database }): Task {
  return async (_payload, helpers) => {
    await runSweepActiveSessions({
      db: deps.db,
      enqueueBuffer: (sessionId) => enqueueBufferRefill(helpers.addJob, sessionId),
    });
  };
}
