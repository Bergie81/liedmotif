// Deletion queue: durable work items for the retention/cleanup worker (reject
// purge after ~24h, expired-unsaved eviction, orphaned-asset sweep). `trackId`
// is nullable so an item can target an orphaned `storageKey` with no track row;
// `reason` is open text (cleanup reasons grow). The worker scans by `deleteAfter`
// and marks `processedAt`. Processed rows are retained (audit trail), so the due
// scan indexes ONLY the unprocessed slice — a partial index stays tiny while the
// table grows append-heavy.

import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk } from './_columns';
import { user } from './auth';
import { tracks } from './tracks';

export const deletionQueueItems = pgTable(
  'deletion_queue_items',
  {
    id: pk(),
    // Nullable + set-null: deleting a Member first ENQUEUES their storage keys
    // and then lets the user cascade run — a cascading queue row would erase
    // the very keys it exists to reclaim. The drain worker never reads the
    // owner; null also covers keys queued after the owner row is gone.
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
    storageKey: text('storage_key'),
    reason: text('reason').notNull(),
    deleteAfter: timestamp('delete_after', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    errorMessageSafe: text('error_message_safe'),
    createdAt: createdAt(),
  },
  (table) => [
    // Matches the worker's due scan exactly: unprocessed items ordered by due time.
    index('deletion_queue_items_due_idx')
      .on(table.deleteAfter)
      .where(sql`${table.processedAt} is null`),
    // RI set-null probes: track delete and user delete each check this table
    // per deleted parent row.
    index('deletion_queue_items_track_id_idx').on(table.trackId),
    index('deletion_queue_items_owner_idx').on(table.ownerUserId),
  ],
);
