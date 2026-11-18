// Feedback + playback event logs.
//
// `feedback_events` is the audit trail (dislike/skip/save/favorite) —
// track flags remain the source of truth for state; this records the actions.
// `playback_events` persists only started/ended/skipped/failed (periodic position
// pings update live session fields, not rows).

import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, ownerUserId, pk, userId } from './_columns';
import { feedbackType, playbackEventType } from './enums';
import { activitySessions, activitySessionQueueItems } from './sessions';
import { tracks } from './tracks';

export const feedbackEvents = pgTable(
  'feedback_events',
  {
    id: pk(),
    userId: userId(),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    activitySessionId: uuid('activity_session_id').references(() => activitySessions.id, {
      onDelete: 'set null',
    }),
    feedbackType: feedbackType('feedback_type').notNull(),
    feedbackValue: text('feedback_value'),
    freeformText: text('freeform_text'),
    createdAt: createdAt(),
  },
  (table) => [
    index('feedback_events_track_id_idx').on(table.trackId),
    // RI probes for the set-null/cascade paths: session delete and user delete
    // each check this table per deleted parent row.
    index('feedback_events_session_id_idx').on(table.activitySessionId),
    index('feedback_events_user_id_idx').on(table.userId),
  ],
);

export const playbackEvents = pgTable(
  'playback_events',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    // Set null, not cascade: a `started` row is the Track's play history
    // (`hasPlayed`), which outlives the Session that played it.
    activitySessionId: uuid('activity_session_id').references(() => activitySessions.id, {
      onDelete: 'set null',
    }),
    queueItemId: uuid('queue_item_id').references(() => activitySessionQueueItems.id, {
      onDelete: 'set null',
    }),
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    eventType: playbackEventType('event_type').notNull(),
    // Client-minted idempotency key for the logical playback event (contract:
    // reportPlaybackState is idempotent via `clientEventId`). A retry reuses the
    // same id so the unique index below dedupes started/ended/skipped/failed and
    // they never double-count. Nullable only because legacy/direct inserts may omit
    // it; the playback route always supplies one for persisted events.
    clientEventId: text('client_event_id'),
    positionSeconds: doublePrecision('position_seconds'),
    clientTimestamp: timestamp('client_timestamp', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('playback_events_session_created_at_idx').on(table.activitySessionId, table.createdAt),
    index('playback_events_queue_item_id_idx').on(table.queueItemId),
    // Full track_id index for the FK set-null probe on track delete. The partial
    // started-only index below cannot serve it: the RI trigger must find
    // ended/skipped/failed rows too, so this is not redundant with it.
    index('playback_events_track_id_idx').on(table.trackId),
    // RI probe on user delete (owner cascade fans out per deleted user row).
    index('playback_events_owner_user_id_idx').on(table.ownerUserId),
    index('playback_events_started_track_idx')
      .on(table.trackId)
      .where(sql`${table.eventType} = 'started' and ${table.trackId} is not null`),
    // Retention prune (`pruneEventTables`): the rows past the horizon that no
    // product read can reach. Partial on the same predicate the prune uses, so
    // the scan never walks the `started`-for-a-live-track rows it must keep.
    index('playback_events_prunable_idx')
      .on(table.createdAt)
      .where(sql`${table.eventType} <> 'started' or ${table.trackId} is null`),
    // Dedupe persisted events per session: a retried report with the same
    // client_event_id collides here and the insert is a no-op (ON CONFLICT DO
    // NOTHING). Scoped to the session because events are always queried by session.
    // Rows orphaned by a Session delete hold NULL here and never collide (NULLs
    // are distinct); they are closed events, nothing writes to them again.
    uniqueIndex('playback_events_session_client_event_id_uq').on(
      table.activitySessionId,
      table.clientEventId,
    ),
  ],
);
