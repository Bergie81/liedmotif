// Listener-profile repository: the Settings → Profile read/write (name/email on
// the Better Auth `user` row + the owner's `listener_profiles` row) and the compact
// context object the session routes hand the text LLM. Profile data is
// volunteered by the user and never processed or analyzed beyond prompt
// assembly. It is private prompt data and must not be logged.

import { and, eq, sql } from 'drizzle-orm';
import type { ListenerContext } from '@liedmotif/shared';
import type { Database } from '../client';
import { listOpenMemberInvites, voidOpenLinks } from '../invites/invites-repo';
import { deleteOtherLogins } from '../logins';
import { isEmailUniqueViolation } from '../pg-errors';
import { renameOwnerPersonFollowingUser } from '../people/people-repo';
import { user, listenerProfiles } from '../schema';
import { withTransaction, type DbOrTx } from '../transactions';

export type { ListenerContext };

/** The full editable profile shown on Settings → Profile. */
export interface ListenerProfile {
  name: string;
  email: string;
  city: string;
  country: string;
  /** Exported-MP3 artist metadata; '' means unset (fall back to the User name). */
  artistName: string;
  /**
   * Short self-description on the owner's Lounge profile card, shown to the Users
   * their In-Lounge playlists are shared with; '' means unset. Never LLM context.
   */
  description: string;
}

/** A profile with nothing in it, for a surface rendering before the first save. */
export const EMPTY_LISTENER_PROFILE: ListenerProfile = {
  name: '',
  email: '',
  city: '',
  country: '',
  artistName: '',
  description: '',
};

/** The user's profile (auth row + `listener_profiles`), or `null` for an unknown user. */
export async function getListenerProfile(
  db: DbOrTx,
  userId: string,
): Promise<ListenerProfile | null> {
  const rows = await db
    .select({
      name: user.name,
      email: user.email,
      city: listenerProfiles.city,
      country: listenerProfiles.country,
      artistName: listenerProfiles.artistName,
      description: listenerProfiles.description,
    })
    .from(user)
    .leftJoin(listenerProfiles, eq(listenerProfiles.ownerUserId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // The left join yields nulls before the first profile save.
  return {
    name: row.name,
    email: row.email,
    city: row.city ?? '',
    country: row.country ?? '',
    artistName: row.artistName ?? '',
    description: row.description ?? '',
  };
}

/**
 * Persist the full profile atomically: name/email onto the Better Auth `user`
 * row (email is the login identifier — an address another account signs in with
 * is refused as `email_in_use`, and moving onto one an open Invite carries as
 * `email_has_open_invite`; moving it clears Confirmed email and voids the
 * open reset links, which went to the address the account is leaving), the
 * rest upserted into the owner's `listener_profiles` row. One transaction, so a
 * refused address or a failed upsert never
 * leaves the name/email changed with the details dropped. A blank `artistName`
 * or `description` stores NULL (unset).
 */
export interface UpdateListenerProfileOptions {
  /**
   * The caller's own Login token, supplied ONLY when the save moves the login
   * email. Every other Login for the user is then revoked in the same
   * transaction, so the identifier and the set of browsers allowed to use it
   * change together: a rejected write (a duplicate address) revokes nothing,
   * and a committed one can never leave the revocation undone.
   */
  revokeOtherLoginsExcept?: string;
}

export type UpdateListenerProfileResult =
  { ok: true } | { ok: false; reason: 'email_in_use' | 'email_has_open_invite' };

export async function updateListenerProfile(
  db: Database,
  userId: string,
  profile: ListenerProfile,
  options: UpdateListenerProfileOptions = {},
): Promise<UpdateListenerProfileResult> {
  try {
    return await writeListenerProfile(db, userId, profile, options);
  } catch (error) {
    if (isEmailUniqueViolation(error)) return { ok: false, reason: 'email_in_use' };
    throw error;
  }
}

async function writeListenerProfile(
  db: Database,
  userId: string,
  profile: ListenerProfile,
  options: UpdateListenerProfileOptions,
): Promise<UpdateListenerProfileResult> {
  return withTransaction(db, async (tx) => {
    const [before] = await tx
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const nextEmail = profile.email.toLowerCase();
    const emailMoves = before !== undefined && before.email.toLowerCase() !== nextEmail;
    // An emailed Invite is bound to its address, so a User taking it first would
    // leave the invitee a link they can never claim. A read, not a reservation:
    // an Invite minted at the same moment can still collide at its claim.
    if (
      emailMoves &&
      (await listOpenMemberInvites(tx)).some((open) => open.email?.toLowerCase() === nextEmail)
    ) {
      return { ok: false as const, reason: 'email_has_open_invite' as const };
    }
    await tx
      .update(user)
      .set({
        name: profile.name,
        email: profile.email,
        // A new address has proved nothing yet. Compared with the stored address
        // in this same statement, so no path that moves the email can leave it
        // confirmed.
        emailVerified: sql`${user.emailVerified} AND lower(${user.email}) = lower(${profile.email})`,
      })
      .where(eq(user.id, userId));
    if (emailMoves) {
      await voidOpenLinks(tx, { kind: 'password_reset', targetUserId: userId, now: new Date() });
    }
    // The owner Person follows the User name until it is given one of its own, so
    // it travels inside this transaction rather than as a second write a caller
    // could forget or half-apply.
    if (before) {
      await renameOwnerPersonFollowingUser(tx, {
        ownerUserId: userId,
        previousUserName: before.name,
        nextUserName: profile.name,
      });
    }
    const details = {
      city: profile.city,
      country: profile.country,
      artistName: profile.artistName.trim() || null,
      description: profile.description.trim() || null,
    };
    await tx
      .insert(listenerProfiles)
      .values({ ownerUserId: userId, ...details })
      .onConflictDoUpdate({
        target: listenerProfiles.ownerUserId,
        set: { ...details, updatedAt: new Date() },
      });
    if (options.revokeOtherLoginsExcept) {
      await deleteOtherLogins(tx, userId, options.revokeOtherLoginsExcept);
    }
    return { ok: true as const };
  });
}

/**
 * Whether the user's current address is a Confirmed email. Read from the row:
 * the session cookie cache lags behind a confirm made on another device.
 */
export async function isEmailConfirmed(db: DbOrTx, userId: string): Promise<boolean> {
  const rows = await db
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.emailVerified ?? false;
}

/**
 * The user's sign-in address while it is a Confirmed email, else null. One row
 * read for both facts, so a reset mail never goes to an address that moved
 * between a confirmed check and the send.
 */
export async function getConfirmedEmail(db: DbOrTx, userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(and(eq(user.id, userId), eq(user.emailVerified, true)))
    .limit(1);
  return rows[0]?.email ?? null;
}

/** The User signing in with `email`, matched case-insensitively, or null. */
export async function findUserByEmail(
  db: DbOrTx,
  email: string,
): Promise<{ id: string; email: string; emailVerified: boolean } | null> {
  const rows = await db
    .select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Which user's `image` currently references this avatar URL — the serving
 * route's ownership lookup. Avatar ids are minted per upload and stored only
 * on the owning `user` row, so an exact-match hit IS the live avatar of that
 * one user; a replaced or unknown id matches nobody and reads as absent.
 */
export async function getAvatarOwnerUserId(db: DbOrTx, imageUrl: string): Promise<string | null> {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.image, imageUrl)).limit(1);
  return rows[0]?.id ?? null;
}

/** The stored profile-image URL on the Better Auth `user` row, or null when unset. */
export async function getUserImage(db: DbOrTx, userId: string): Promise<string | null> {
  const rows = await db
    .select({ image: user.image })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.image ?? null;
}

/**
 * The LLM-facing context for an owner, or `null` when there is nothing useful —
 * so callers can skip the personalization plumbing entirely for a blank profile.
 * The artist name, description, and cover-reference settings are deliberately
 * excluded: they shape exported metadata, the Lounge profile card, and cover
 * generation, not LLM prompts.
 */
export async function getListenerContext(
  db: Database,
  userId: string,
): Promise<ListenerContext | null> {
  const profile = await getListenerProfile(db, userId);
  if (!profile) return null;
  const context: ListenerContext = {};
  for (const key of ['name', 'city', 'country'] as const) {
    const value = profile[key].trim();
    if (value) context[key] = value;
  }
  return Object.keys(context).length > 0 ? context : null;
}
