// One-shot link tokens: Member invites, password-reset links, and
// email-confirm links.
//
// One table backs every link kind — a link is a label, a hashed token, an
// expiry, and at most one consumption. The plaintext token exists only in the
// URL that is copied over or mailed; the row stores its SHA-256, so a database
// read can never recover a claimable link. Consumption is a conditional update
// on `consumed_at IS NULL`, which is what makes every link single-use under
// concurrency.

import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { MemberLimits } from '@liedmotif/shared';
import { createdAt, pk } from './_columns';
import { user } from './auth';

export const INVITE_KINDS = ['member_invite', 'password_reset', 'email_confirm'] as const;
export type InviteKind = (typeof INVITE_KINDS)[number];

/**
 * A consumed invite is the audit trail of how a Member joined: the row stays
 * after consumption and even after the Member is deleted (`consumed_by_user_id`
 * goes null with the user, the label and dates remain). A `password_reset` row
 * instead points at an existing user via `target_user_id` and dies with them —
 * a reset link must never outlive the account it would unlock. An
 * `email_confirm` row targets its user the same way.
 */
export const invites = pgTable(
  'invites',
  {
    id: pk(),
    kind: text('kind').notNull().$type<InviteKind>(),
    /** Who this link is for, in the Admin's words (e.g. "Lisa"). */
    label: text('label').notNull(),
    /** SHA-256 hex of the URL token; lookup is by hash only. */
    tokenHash: text('token_hash').notNull(),
    /**
     * `member_invite` only: the MemberLimits budget the Member starts with.
     * Snapshotted onto the Member's `user_settings.limits` at claim — later
     * edits to this row never reach a claimed Member.
     */
    budget: jsonb('budget').$type<MemberLimits>(),
    /** `password_reset` / `email_confirm`: whose account the link acts on. */
    targetUserId: text('target_user_id').references(() => user.id, { onDelete: 'cascade' }),
    /**
     * The address the link is bound to. `email_confirm`: it confirms only
     * while the account still has that address. `member_invite`: set when the
     * Invite was mailed, and the claim takes it as the Member's login.
     * `password_reset`: always null — the link acts on `target_user_id`, and a
     * mailed one carries the address it went to in `label`.
     */
    email: text('email'),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByUserId: text('consumed_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('invites_token_hash_unique').on(table.tokenHash),
    // RI probes on user delete (cascade for target/creator, set-null for consumer).
    index('invites_target_user_idx').on(table.targetUserId),
    index('invites_created_by_idx').on(table.createdByUserId),
    index('invites_consumed_by_idx').on(table.consumedByUserId),
  ],
);

export type InviteRow = typeof invites.$inferSelect;
