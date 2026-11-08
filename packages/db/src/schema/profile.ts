// Per-user profile tables.
//
// `user_profiles` is the role/account row (1:1 with `user`): who is the Admin,
// who is a Member, and whether the account is disabled. `listener_profiles`
// carries the personal details the user volunteers on Settings → Profile
// (city / country; name and email live on the Better Auth `user` row).
// Person-specific private context belongs to `people`.

import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';
import { user } from './auth';
import { coverReferenceFrequency } from './enums';

/**
 * One row per user: `role` plus account state. `role` is `text` (not an enum)
 * so a future role needs no `ALTER TYPE`; it carries no default so every insert
 * states the role it means. `disabledAt` blocks sign-in and spend when set.
 *
 * The partial unique index enforces the invariant at the DB layer: **at most
 * one admin**. Because every admin row carries `role = 'admin'`, a unique index
 * over `role` filtered to that value permits exactly one such row — so even two
 * concurrent first-run sign-ups (a logical-check race) can never mint a second
 * admin. Member rows fall outside the predicate.
 */
export const userProfiles = pgTable(
  'user_profiles',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: createdAt(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('user_profiles_single_admin')
      .on(table.role)
      .where(sql`${table.role} = 'admin'`),
    // Supports "list all Members" in creation order.
    index('user_profiles_role_created_at_idx').on(table.role, table.createdAt),
  ],
);

export const listenerProfiles = pgTable(
  'listener_profiles',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    city: text('city').notNull().default(''),
    country: text('country').notNull().default(''),
    /** Optional exported-MP3 artist name (`TPE1`); null falls back to the User name. */
    artistName: text('artist_name'),
    /** Optional short self-description shown on the owner's Lounge profile card;
     *  null = unset. Never part of the LLM listener context. */
    description: text('description'),
    /** No-name owner fallback preference, edited on Settings → People. */
    coverReferenceFrequency: coverReferenceFrequency('cover_reference_frequency')
      .notNull()
      .default('regularly'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One listener profile per owner.
    uniqueIndex('listener_profiles_owner_user_id_unique').on(table.ownerUserId),
  ],
);
