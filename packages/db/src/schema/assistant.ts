// The Assistant's one table. The conversation itself is never stored; all the
// server keeps is how many messages a user sent on a day.

import { date, integer, pgTable, primaryKey } from 'drizzle-orm/pg-core';
import { userId } from './_columns';

/**
 * How many Assistant messages a user sent on one day, the count their daily
 * allowance is held against. `day` is the calendar date in the Instance
 * timezone, so a count starts over at local midnight there. A row exists only
 * once a message was counted that day.
 */
export const assistantUsage = pgTable(
  'assistant_usage',
  {
    userId: userId(),
    day: date('day', { mode: 'string' }).notNull(),
    messages: integer('messages').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.day] })],
);
