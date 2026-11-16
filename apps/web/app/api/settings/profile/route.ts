// Member-or-Admin: update the signed-in user's listener/account fields. Person
// context and the no-name cover fallback are managed under Settings → People.
//
// Logging note: profile fields are volunteered personal data the app never
// processes or analyzes beyond LLM prompt assembly, so they are deliberately
// EXEMPT from the secret-scrubbing rules that apply to provider keys, signed
// URLs, and raw provider errors — appearing in a server log is acceptable here.
// (Uploaded cover-reference IMAGES are handled by their own routes and ARE
// log-sensitive.)

import { NextResponse } from 'next/server';
import {
  getConfirmedEmail,
  getListenerProfile,
  listFinalMp3TrackIdsForOwner,
  updateListenerProfile,
  verifyCredentialPassword,
  type ListenerProfile,
} from '@liedmotif/db';
import {
  MAX_EMAIL_LENGTH,
  MAX_PROFILE_ARTIST_NAME_LENGTH,
  MAX_PROFILE_DESCRIPTION_LENGTH,
  MAX_PROFILE_FIELD_LENGTH,
  MAX_USER_NAME_LENGTH,
} from '@liedmotif/shared';
import { mailConfirmLink, mailEmailChangedNotice } from '@/lib/account-mail';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { badRequest, clientIp, forbidden, tooManyRequests } from '@/lib/http';
import { readJsonObjectBody, requireOwnerId } from '@/lib/api-response';
import { cachedUserProfile } from '@/lib/request-cache';
import { loginFailureLimiter } from '@/lib/request-limits';
import { currentLoginToken, refreshSessionCookieCache } from '@/lib/session';
import { enqueueEmbedTrackMetadataBatch } from '@/lib/worker-jobs';

export const dynamic = 'force-dynamic';

/** Loose shape check only — the format beyond this is the user's own concern
 *  (they lock themselves out at worst and recover through the reset CLI), and
 *  uniqueness is the DB's, refused as already in use. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim a body field, or `null` when it is not a string or exceeds `maxLength`. */
function textField(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : null;
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;

  const name = textField(body.name, MAX_USER_NAME_LENGTH);
  const email = textField(body.email, MAX_EMAIL_LENGTH);
  const city = textField(body.city, MAX_PROFILE_FIELD_LENGTH);
  const country = textField(body.country, MAX_PROFILE_FIELD_LENGTH);
  const artistName = textField(body.artistName ?? '', MAX_PROFILE_ARTIST_NAME_LENGTH);
  // Whitespace runs collapse so the stored description is exactly what the card shows.
  const description =
    textField(body.description ?? '', MAX_PROFILE_DESCRIPTION_LENGTH)?.replace(/\s+/g, ' ') ?? null;

  if (typeof body.name === 'string' && body.name.trim().length > MAX_USER_NAME_LENGTH) {
    return badRequest(`Name must be at most ${MAX_USER_NAME_LENGTH} characters.`);
  }
  if (!name) return badRequest('Enter a name.');
  if (!email || !EMAIL_PATTERN.test(email)) return badRequest('Enter a valid email address.');
  if (city === null || country === null) {
    return badRequest('City and country must be text within the length limits.');
  }
  if (artistName === null) {
    return badRequest(
      `Artist name must be text of at most ${MAX_PROFILE_ARTIST_NAME_LENGTH} characters.`,
    );
  }
  if (description === null) {
    return badRequest(
      `Description must be text of at most ${MAX_PROFILE_DESCRIPTION_LENGTH} characters.`,
    );
  }

  const db = getDb();
  // The prior artist value decides whether exported MP3s need a retag below,
  // and the prior email decides whether this save moves the login identifier.
  // Name changes matter too: the artist falls back to the User name when the
  // Artist Name is unset.
  const previous = await getListenerProfile(db, ownerUserId);
  if (!previous) return badRequest('Could not read your profile.');

  // The email IS the login identifier, so moving it is an account-recovery act,
  // not a profile edit: a stolen session that could do it silently would own the
  // account outright (change the address, then mint a reset link to it). Proving
  // the current password is what a session cookie cannot do on its own, and the
  // other browsers the user may no longer account for lose their Logins with it.
  const emailChanged = previous.email.toLowerCase() !== email.toLowerCase();
  let keepLoginToken: string | undefined;
  let leavingConfirmedEmail: string | null = null;
  if (emailChanged) {
    // Only the Admin moves their own sign-in address; a Member's stays the one
    // the account was created with. The role comes from the profile row, so no
    // request field can claim it.
    if ((await cachedUserProfile(db, ownerUserId))?.role !== 'admin') {
      return forbidden('Your sign-in email can’t be changed.');
    }
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!currentPassword) {
      return badRequest('Enter your current password to change your sign-in address.');
    }
    // Guessing it spends the sign-in failure budget, taken before the check and
    // refunded when the password proves right, as on `/sign-in`.
    const ip = clientIp(request);
    const budget = loginFailureLimiter.check(ip);
    if (!budget.allowed) return tooManyRequests(budget.retryAfterMs);
    if (!(await verifyCredentialPassword(db, ownerUserId, currentPassword))) {
      return badRequest('That password is not correct.');
    }
    loginFailureLimiter.refund(ip);
    // Without knowing which Login is this browser there is no safe revocation
    // to perform, so the change does not happen at all.
    keepLoginToken = (await currentLoginToken()) ?? undefined;
    if (!keepLoginToken) return badRequest('Could not confirm your sign-in. Sign in again.');
    // Read before the save, which unconfirms the account.
    if (isAccountEmailEnabled()) leavingConfirmedEmail = await getConfirmedEmail(db, ownerUserId);
  }

  const profile: ListenerProfile = {
    name,
    // Sign-in lowercases the typed address and matches the stored one exactly,
    // so a new address is stored lowercased, and a casing-only difference keeps
    // the stored spelling instead of rewriting it.
    email: emailChanged ? email.toLowerCase() : previous.email,
    city,
    country,
    artistName,
    description,
  };
  const saved = await updateListenerProfile(db, ownerUserId, profile, {
    revokeOtherLoginsExcept: keepLoginToken,
  });
  if (!saved.ok) return badRequest('That email is already in use. Pick another.');
  // Name/email live on the Better Auth user row, which sessions cache in a
  // signed cookie — pull the fresh row into it so the account chip doesn't
  // show the old name for the cache's lifetime.
  await refreshSessionCookieCache();

  const previousArtist = previous.artistName.trim() || previous.name;
  const nextArtist = artistName || name;
  if (previousArtist !== nextArtist) {
    // Keep already-exported metadata current (best-effort, worker-side).
    const trackIds = await listFinalMp3TrackIdsForOwner(db, ownerUserId);
    await enqueueEmbedTrackMetadataBatch(db, trackIds);
  }

  // The moved address starts unconfirmed. Mailed after the save commits, so a
  // mail server that cannot be reached never undoes the change — the response
  // only reports that the link did not go out.
  const confirmLinkSent =
    emailChanged && isAccountEmailEnabled()
      ? await mailConfirmLink(db, { userId: ownerUserId, email: profile.email })
      : undefined;
  // The address the account left hears of the move, in case it was not the
  // owner who moved it — only when it was confirmed, since an unconfirmed one
  // may be a setup placeholder or someone else's inbox. Best-effort, after the
  // confirm link, and not reported.
  if (leavingConfirmedEmail) {
    await mailEmailChangedNotice({ oldEmail: leavingConfirmedEmail, newEmail: profile.email });
  }

  return NextResponse.json({ ok: true, profile, confirmLinkSent });
}
