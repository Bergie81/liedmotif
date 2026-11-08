// Small reusable column builders shared across the app tables.
//
// Each is a FUNCTION returning a fresh builder — Drizzle column builders are
// stateful, so a shared instance must never be reused across tables. App tables
// use `timestamptz` (a deliberate departure from Better Auth's plain
// `timestamp`): every app timestamp is an instant in time — poll/retention/reset
// scheduling — and `timestamptz` avoids wall-clock ambiguity when the server
// timezone changes. PKs are random UUIDs (`gen_random_uuid()`, built into PG13+).

import { sql } from 'drizzle-orm';
import { text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';

/** Random-UUID primary key. */
export const pk = () => uuid('id').primaryKey().defaultRandom();

/** `created_at timestamptz NOT NULL DEFAULT now()`. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

/** `updated_at timestamptz NOT NULL DEFAULT now()`, bumped by Drizzle on update. */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/**
 * `owner_user_id text NOT NULL` FK to Better Auth's `user.id` — the ownership
 * link every user-owned aggregate carries. Cascade-deletes
 * the owner's content if the user is ever removed.
 */
export const ownerUserId = () =>
  text('owner_user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });

/** `user_id text NOT NULL` FK to `user.id` — used by usage/feedback/playback events. */
export const userId = () =>
  text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' });

/** A `timestamptz` default produced by raw SQL `now()`, for non-helper columns. */
export const nowDefault = () => sql`now()`;
