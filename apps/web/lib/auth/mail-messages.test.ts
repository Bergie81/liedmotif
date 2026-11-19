import { describe, expect, it } from 'vitest';
import {
  confirmEmailMessage,
  emailChangedNoticeMessage,
  memberInviteMessage,
  passwordResetMessage,
} from './mail-messages';

describe('account mail messages', () => {
  // The token is the account-acting secret: it may travel only inside the one
  // link, never in the subject line inbox previews and mail logs show.
  it.each([
    ['confirm', confirmEmailMessage],
    ['reset', passwordResetMessage],
    ['join', (link: string) => memberInviteMessage(link, 'John')],
  ])('the %s mail carries its link once, and the token nowhere else', (kind, build) => {
    const token = 'Zt3xQ9vB2kLmN8pR4sW6yA1cE5gH7jK0oU-_fDqVwXs';
    const link = `https://music.example/${kind}/${token}`;

    const message = build(link);

    expect(message.text).toContain(link);
    expect(message.text.split(token)).toHaveLength(2);
    expect(message.subject).not.toContain(token);
  });

  // The notice goes to the address the account just left, so it acts on
  // nothing: recovery happens on the server, never through a link.
  it('the email-changed notice names both addresses and carries no link', () => {
    const message = emailChangedNoticeMessage({
      oldEmail: 'lisa@example.test',
      newEmail: 'lisa@new.example',
    });

    expect(message.text).toContain('lisa@example.test');
    expect(message.text).toContain('lisa@new.example');
    expect(message.text).toContain('reset-admin-password');
    expect(message.text).not.toMatch(/https?:\/\//);
  });
});
