// The text of every account mail: subject and plain-text body per mail kind,
// English only. Pure — the caller builds the link and owns the recipient. A
// link carries a one-shot token, so it appears in the body only, never in a
// subject that inbox previews and mail logs show.

import type { EmailMessage } from '@liedmotif/providers/email';

export type MailContent = Omit<EmailMessage, 'to'>;

export function confirmEmailMessage(link: string): MailContent {
  return {
    subject: 'Confirm your Liedmotif email',
    text: [
      'Open this link to confirm that this address belongs to your Liedmotif account:',
      '',
      link,
      '',
      'The link works once, for 24 hours. If this wasn’t you, ignore this mail.',
    ].join('\n'),
  };
}

export function passwordResetMessage(link: string): MailContent {
  return {
    subject: 'Reset your Liedmotif password',
    text: [
      'Open this link to pick a new password for your Liedmotif account:',
      '',
      link,
      '',
      'The link works once, for 1 hour. If you didn’t ask for this, ignore this mail; your password stays as it is.',
    ].join('\n'),
  };
}

/**
 * Goes to the address the account just left, so it carries no link that acts
 * on the account: recovery is the reset CLI on the server.
 */
export function emailChangedNoticeMessage(input: {
  oldEmail: string;
  newEmail: string;
}): MailContent {
  return {
    subject: 'Your Liedmotif sign-in email was changed',
    text: [
      `The sign-in email of your Liedmotif account changed from ${input.oldEmail} to ${input.newEmail}.`,
      '',
      'If this was you, there is nothing to do.',
      '',
      'If it wasn’t, take the account back on the server that runs Liedmotif: set a new password with the reset tool, which also signs out every device. Run these in the folder that holds its docker-compose.yml, and type the new password after the first line (it stays hidden):',
      '',
      '  read -rs ADMIN_RESET_PASSWORD && export ADMIN_RESET_PASSWORD',
      '  docker compose exec -e ADMIN_RESET_PASSWORD worker node dist/reset-admin-password.js',
      '  unset ADMIN_RESET_PASSWORD',
      '',
      `Then sign in as ${input.newEmail} with that password and change the email back in Settings → Profile. The Liedmotif docs (Members, “If you forget the admin password”) have the details.`,
    ].join('\n'),
  };
}

/** `from` is the inviting Admin's display name; null when they have none. */
export function memberInviteMessage(link: string, from: string | null): MailContent {
  const inviter = from ?? 'The owner of a Liedmotif instance';
  return {
    subject: from ? `${from} invited you to Liedmotif` : 'You’re invited to Liedmotif',
    text: [
      `${inviter} invited you to your own private listening space on Liedmotif.`,
      '',
      'Open this link to create your account. This address becomes your sign-in email:',
      '',
      link,
      '',
      'The link works once, for 7 days. If you weren’t expecting this, ignore this mail.',
    ].join('\n'),
  };
}

/**
 * An Instance alert, already composed by the evaluator. The host is the one
 * identifying detail, there so an Admin with two Instances can tell them apart.
 */
export function instanceAlertMessage(input: {
  title: string;
  message: string;
  instance: string;
}): MailContent {
  return {
    subject: input.title,
    text: [input.message, '', `Instance: ${input.instance}`].join('\n'),
  };
}
