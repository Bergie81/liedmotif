// `finish-deferred-session-deletes` recurring job: completes each Session delete
// that was asked while provider or cover work was still in flight, once that
// work has settled. Until then the session stays pending and out of sight.

import { finishDeferredSessionDeletes, type Database } from '@liedmotif/db';
import type { Task } from 'graphile-worker';

/** Bind to Graphile (recurring via `RECURRING_CRONTAB`). */
export function createFinishDeferredSessionDeletesTask(deps: { db: Database }): Task {
  return async (_payload, helpers) => {
    const { deletedSessionIds, failedSessionIds } = await finishDeferredSessionDeletes(deps.db);
    if (deletedSessionIds.length || failedSessionIds.length) {
      helpers.logger.info(
        `finish-deferred-session-deletes deleted=${deletedSessionIds.length} failed=${failedSessionIds.length}`,
      );
    }
  };
}
