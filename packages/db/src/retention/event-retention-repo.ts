// Retention for the append-only event tables. Inserts are
// cheap and every hot read is indexed, so this is disk growth over years rather
// than a query problem — which makes the decision each table needs "what still
// has product meaning", not "what is slow". One decision per table, recorded
// here because the tables themselves cannot state it:
//
// `feedback_events` — KEPT FOREVER, deliberately unpruned. It is the audit trail
//   the whole retention model rests on (playlist membership is the
//   retention rule and these rows are its history). Every row hard-references
//   a track with `ON DELETE CASCADE` on a non-null column, but Track rows are
//   only ever removed with their owner — a Disliked or Deleted Track stays as
//   a tombstone — so the table grows with feedback and is bounded only by
//   Member deletion.
//
// `playback_events` — PRUNED past `PLAYBACK_EVENT_RETENTION_DAYS`, minus the
//   rows that still answer a live product question. The app has exactly two
//   readers and both ask the same one — "does a `started` row exist for this
//   track?" (the Library's `hasPlayed` column and the Dislike reroll's
//   unplayed-sibling probe) — so a `started` row still pointing at a track is
//   kept at any age, whether or not its Session still exists — including one
//   pointing at a tombstoned (rejected or deleted) track, whose row is never
//   removed. Everything else past the
//   horizon is telemetry nothing reads: the ended/skipped/failed rows, and any
//   row whose track is gone (`ON DELETE SET NULL` leaves it unreachable by
//   either predicate).
//
// `usage_events` — PRUNED past `USAGE_EVENT_RETENTION_DAYS`, unconditionally.
//   It is the diagnostics-only spend ledger: nothing reads it,
//   and limit accounting provably cannot — the daily and monthly windows count
//   `provider_jobs` rows (`countTasksInWindow`), which a prune here never
//   touches. Both windows are also orders of magnitude shorter than the
//   horizon, so no window that was computable before a prune stops being
//   computable after one.

import { and, inArray, isNull, lt, ne, or, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { playbackEvents, usageEvents } from '../schema';

/** Playback telemetry with no reader is kept this long before pruning. */
export const PLAYBACK_EVENT_RETENTION_DAYS = 180;

/** The spend ledger is kept this long — well past any limit window it informs. */
export const USAGE_EVENT_RETENTION_DAYS = 730;

/** Rows per DELETE statement: bounded so a prune never holds a wide row lock. */
export const EVENT_PRUNE_BATCH_SIZE = 2_000;

/**
 * Statements per table per run. A backlog (the first run after this ships, or a
 * heavy listening month) drains across runs instead of in one long pass that
 * would sit on the table while the app is generating.
 */
export const EVENT_PRUNE_MAX_BATCHES = 25;

export interface PruneEventTablesResult {
  playbackEventsDeleted: number;
  usageEventsDeleted: number;
}

export interface PruneEventTablesOptions {
  /** Injected for deterministic horizons in tests. */
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete every row of one event table matching `condition`, oldest first, in
 * fixed-size statements until the table is drained or the per-run statement
 * budget is spent — a backlog costs runs rather than one long lock on a table
 * the app is still writing to. Each batch reads straight off the `created_at`
 * index the prune predicate is already narrowed by. Returns the total deleted.
 */
async function pruneTable(
  db: Database,
  table: typeof playbackEvents | typeof usageEvents,
  condition: SQL | undefined,
  bounds: { batchSize: number; maxBatches: number },
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < bounds.maxBatches; batch += 1) {
    const doomed = db
      .select({ id: table.id })
      .from(table)
      .where(condition)
      .orderBy(table.createdAt)
      .limit(bounds.batchSize);
    const removed = await db
      .delete(table)
      .where(inArray(table.id, doomed))
      .returning({ id: table.id });
    deleted += removed.length;
    if (removed.length < bounds.batchSize) break;
  }
  return deleted;
}

/**
 * Apply every table's retention decision above. Idempotent and bounded: safe to
 * run on a cadence, and a run that hits its batch budget simply leaves the rest
 * for the next one.
 */
export async function pruneEventTables(
  db: Database,
  options: PruneEventTablesOptions = {},
): Promise<PruneEventTablesResult> {
  const now = options.now ?? new Date();
  const bounds = {
    batchSize: options.batchSize ?? EVENT_PRUNE_BATCH_SIZE,
    maxBatches: options.maxBatches ?? EVENT_PRUNE_MAX_BATCHES,
  };

  const playbackEventsDeleted = await pruneTable(
    db,
    playbackEvents,
    and(
      lt(playbackEvents.createdAt, daysBefore(now, PLAYBACK_EVENT_RETENTION_DAYS)),
      // The kept class, negated: a `started` row whose track still exists is the
      // `hasPlayed`/unplayed-sibling answer and outlives the horizon.
      or(ne(playbackEvents.eventType, 'started'), isNull(playbackEvents.trackId)),
    ),
    bounds,
  );

  const usageEventsDeleted = await pruneTable(
    db,
    usageEvents,
    lt(usageEvents.createdAt, daysBefore(now, USAGE_EVENT_RETENTION_DAYS)),
    bounds,
  );

  return { playbackEventsDeleted, usageEventsDeleted };
}
