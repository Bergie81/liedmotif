// `prune-event-tables` recurring job — the retention path for the append-only
// event logs. The per-table decision (what is pruned, what is kept forever, and
// why) lives with the query in `@liedmotif/db`'s retention module; this is only
// its schedule. Daily, not minutely: the horizons are months, and each run is
// bounded to a fixed statement budget, so a backlog drains over days instead of
// holding the tables the playback route writes to.

import type { Database } from '@liedmotif/db';
import { pruneEventTables } from '@liedmotif/db';
import type { Task } from 'graphile-worker';

/** Bind to Graphile (recurring via `RECURRING_CRONTAB`). */
export function createPruneEventTablesTask(deps: { db: Database }): Task {
  return async (_payload, helpers) => {
    const result = await pruneEventTables(deps.db);
    if (result.playbackEventsDeleted || result.usageEventsDeleted) {
      helpers.logger.info(
        `prune-event-tables removed playback=${result.playbackEventsDeleted} usage=${result.usageEventsDeleted}`,
      );
    }
  };
}
