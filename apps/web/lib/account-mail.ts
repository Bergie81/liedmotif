// The account-email flows' one step that leaves the instance: mint a one-shot
// link and mail it, or mail a notice that carries none. Server-only. Callers
// gate on `isAccountEmailEnabled()` first, and send inside the request — the
// public forgot-password route right after its response — never through a mail
// queue, so a plaintext token never rests anywhere but the mail.

import {
  createEmailConfirmLink,
  createMemberInvite,
  createPasswordResetLink,
  EMAILED_PASSWORD_RESET_TTL_MS,
  findUserByEmail,
  getAdminDisplayName,
  resolveUserProfile,
  revokeInvite,
  type Database,
  type InviteRow,
} from '@liedmotif/db';
import { EmailSendError, type EmailMessage } from '@liedmotif/providers/email';
import { createLogger, type MemberLimits } from '@liedmotif/shared';
import { confirmLinkUrl, joinLinkUrl, resetLinkUrl } from './link-urls';
import {
  confirmEmailMessage,
  emailChangedNoticeMessage,
  instanceAlertMessage,
  memberInviteMessage,
  passwordResetMessage,
} from './mail-messages';
import { getEmailSender } from '@/lib/providers';

const logger = createLogger({ name: 'account-mail' });

/**
 * Send one account mail. False when the mail server refused it or could not be
 * reached; the link inside is then never delivered, and the next mint voids it.
 */
async function deliver(message: EmailMessage, kind: string): Promise<boolean> {
  try {
    await getEmailSender().send(message);
    return true;
  } catch (err) {
    if (!(err instanceof EmailSendError)) throw err;
    logger.warn(`${kind} mail could not be sent`, { code: err.code });
    return false;
  }
}

/** Mail `email` a link that confirms it for `userId`. */
export async function mailConfirmLink(
  db: Database,
  input: { userId: string; email: string },
): Promise<boolean> {
  const { token } = await createEmailConfirmLink(db, {
    targetUserId: input.userId,
    email: input.email,
  });
  return deliver({ to: input.email, ...confirmEmailMessage(confirmLinkUrl(token)) }, 'confirm');
}

/** Tell `oldEmail` that the account it signed in now signs in with `newEmail`. */
export async function mailEmailChangedNotice(input: {
  oldEmail: string;
  newEmail: string;
}): Promise<void> {
  await deliver({ to: input.oldEmail, ...emailChangedNoticeMessage(input) }, 'email-changed');
}

/** Mail one Instance alert to the Admin's Confirmed email. False when it could not be sent. */
export async function mailInstanceAlert(input: {
  to: string;
  title: string;
  message: string;
  instance: string;
}): Promise<boolean> {
  return deliver({ to: input.to, ...instanceAlertMessage(input) }, 'instance-alert');
}

/** Mail `email` a one-hour link that sets a new password for `userId`. */
export async function mailPasswordResetLink(
  db: Database,
  input: { userId: string; email: string; createdByUserId: string; now?: Date },
): Promise<boolean> {
  const { token } = await createPasswordResetLink(db, {
    targetUserId: input.userId,
    label: input.email,
    createdByUserId: input.createdByUserId,
    ttlMs: EMAILED_PASSWORD_RESET_TTL_MS,
    now: input.now,
  });
  return deliver({ to: input.email, ...passwordResetMessage(resetLinkUrl(token)) }, 'reset');
}

/**
 * The deferred half of "Forgot password?": mail a reset link to the account
 * signing in with `email` — only while that address is a Confirmed email and
 * the account is active. An unconfirmed address may be a typo that belongs to
 * someone else, and a Disabled account gets no mail at all. Runs after the reply
 * has gone out, so nothing here can change what the caller sees.
 */
export async function mailForgotPasswordLink(
  db: Database,
  input: { email: string; now?: Date },
): Promise<void> {
  const target = await findUserByEmail(db, input.email);
  if (!target?.emailVerified) return;
  const profile = await resolveUserProfile(db, target.id);
  if (!profile || profile.disabledAt) return;
  await mailPasswordResetLink(db, {
    userId: target.id,
    email: target.email,
    createdByUserId: target.id,
    now: input.now,
  });
}

/**
 * Mint a Member Invite bound to `email` and mail its join link there. Null when
 * the mail could not be sent: the Invite is then revoked, since nobody holds its
 * link and an open row would only block the address until it expires.
 */
export async function mailMemberInvite(
  db: Database,
  input: { label: string; email: string; budget: MemberLimits; createdByUserId: string },
): Promise<InviteRow | null> {
  const { invite, token } = await createMemberInvite(db, input);
  const message = memberInviteMessage(joinLinkUrl(token), await getAdminDisplayName(db));
  if (await deliver({ to: input.email, ...message }, 'invite')) return invite;
  await revokeInvite(db, { id: invite.id });
  return null;
}
