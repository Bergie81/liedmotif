// The Admin resets a Member: the reset link is mailed to the Member's
// Confirmed email while
// account email is on and the account is enabled; otherwise the Admin gets
// the 24-hour link to copy, with the reason it was not mailed. Against a real
// database with a recording mail sender.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findClaimableLink, user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { EmailSendError, type EmailMessage, type EmailSender } from '@liedmotif/providers/email';
import { recordingEmailSender } from '@liedmotif/providers/testing';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  adminId: 'admin-1',
  mail: null as unknown,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: async () => ({ user: { id: holder.adminId } }),
}));
vi.mock('@/lib/providers/providers', () => ({ getEmailSender: () => holder.mail }));

const { POST: resetPasswordPost } =
  await import('@/app/api/settings/members/[userId]/reset-password/route');

const PUBLIC_URL = 'https://music.example';
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function accountEmail(on: boolean): void {
  vi.stubEnv('SMTP_URL', on ? 'smtp://mail.invalid:25' : '');
  vi.stubEnv('MAIL_FROM', on ? 'Liedmotif <liedmotif@example.test>' : '');
}

/** A Member with a stored (lowercased) address, its confirmed state, and its profile. */
async function member(id: string, opts: { confirmed: boolean; disabled?: boolean }) {
  const email = `${id}@example.test`;
  await testDb.db.insert(user).values({ id, name: id, email, emailVerified: opts.confirmed });
  await testDb.db.insert(userProfiles).values({
    userId: id,
    role: 'member',
    disabledAt: opts.disabled ? new Date() : null,
  });
  return email;
}

async function resetPassword(userId: string) {
  const response = await resetPasswordPost(
    new Request(`${PUBLIC_URL}/api/settings/members/${userId}/reset-password`, { method: 'POST' }),
    { params: Promise.resolve({ userId }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()).data as Record<string, unknown>;
}

const sentMail = () => (holder.mail as ReturnType<typeof recordingEmailSender>).sent;

function resetTokenIn(text: string): string {
  const match = text.match(/https:\/\/music\.example\/reset\/([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error('no reset link in the text');
  return match[1];
}

async function claimable(token: string): Promise<boolean> {
  return (await findClaimableLink(testDb.db, { kind: 'password_reset', token })) !== null;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('admin-reset-mails-member-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['invites', 'user']);
  vi.stubEnv('APP_PUBLIC_URL', PUBLIC_URL);
  holder.mail = recordingEmailSender();
  await testDb.db
    .insert(user)
    .values({ id: holder.adminId, name: 'John', email: 'john@example.test' });
  await testDb.db.insert(userProfiles).values({ userId: holder.adminId, role: 'admin' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(skip)('POST /api/settings/members/[userId]/reset-password', () => {
  it('mails a confirmed, enabled Member the reset link and returns no link to copy', async () => {
    accountEmail(true);
    const email = await member('lisa', { confirmed: true });

    const data = await resetPassword('lisa');

    expect(data).toEqual({ sent: true, to: email });
    expect(sentMail().map((sent) => sent.to)).toEqual([email]);
    expect(await claimable(resetTokenIn(sentMail()[0]!.text))).toBe(true);
  });

  it.each([
    { reason: 'email_off', emailOn: false, confirmed: true, disabled: false },
    { reason: 'unconfirmed', emailOn: true, confirmed: false, disabled: false },
    { reason: 'disabled', emailOn: true, confirmed: true, disabled: true },
  ])('hands over a link to copy, mailing nothing, when $reason', async (row) => {
    accountEmail(row.emailOn);
    await member('lisa', { confirmed: row.confirmed, disabled: row.disabled });

    const data = await resetPassword('lisa');

    expect(data).toEqual({
      url: expect.stringContaining(`${PUBLIC_URL}/reset/`),
      reason: row.reason,
    });
    expect(sentMail()).toEqual([]);
    expect(await claimable(resetTokenIn(data.url as string))).toBe(true);
  });

  it('a mail that could not be sent falls back to a link to copy and voids the undelivered one', async () => {
    accountEmail(true);
    await member('lisa', { confirmed: true });
    const send = vi.fn<(message: EmailMessage) => Promise<void>>();
    send.mockRejectedValue(new EmailSendError('ECONNECTION'));
    holder.mail = { send } satisfies EmailSender;

    const data = await resetPassword('lisa');

    expect(data).toEqual({
      url: expect.stringContaining(`${PUBLIC_URL}/reset/`),
      reason: 'send_failed',
    });
    expect(await claimable(resetTokenIn(send.mock.calls[0]![0].text))).toBe(false);
    expect(await claimable(resetTokenIn(data.url as string))).toBe(true);
  });

  it("a new mint voids the Member's older open link", async () => {
    await member('lisa', { confirmed: true });
    accountEmail(false);
    const copied = resetTokenIn((await resetPassword('lisa')).url as string);
    accountEmail(true);

    await resetPassword('lisa');

    expect(await claimable(copied)).toBe(false);
    expect(await claimable(resetTokenIn(sentMail()[0]!.text))).toBe(true);
  });
});
