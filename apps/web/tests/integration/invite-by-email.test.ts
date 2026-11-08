// Invite by email: with account email on,
// the Admin's Invite is bound to an address and mailed there — no link comes
// back to copy; with it off, the Invite is a link to copy. Against a real
// database with a recording mail sender.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listOpenMemberInvites, user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { EmailSendError, type EmailSender } from '@liedmotif/providers/email';
import { recordingEmailSender } from '@liedmotif/providers/testing';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  adminId: 'admin-1',
  mail: null as unknown,
}));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => ({ user: { id: holder.adminId } }),
}));
vi.mock('@/lib/providers', () => ({ getEmailSender: () => holder.mail }));

const { POST: createInvite } = await import('@/app/api/settings/members/invites/route');

const PUBLIC_URL = 'https://music.example';
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

function accountEmail(on: boolean): void {
  vi.stubEnv('SMTP_URL', on ? 'smtp://mail.invalid:25' : '');
  vi.stubEnv('MAIL_FROM', on ? 'Liedmotif <liedmotif@example.test>' : '');
}

function invite(body: Record<string, unknown>): Promise<Response> {
  return createInvite(
    new Request(`${PUBLIC_URL}/api/settings/members/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Lisa', ...body }),
    }),
  );
}

const sentMail = () => (holder.mail as ReturnType<typeof recordingEmailSender>).sent;

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('invite-by-email-test');
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

describe.skipIf(skip)('POST /api/settings/members/invites — invite by email', () => {
  it('mails the join link to the address and returns no link to copy', async () => {
    accountEmail(true);

    const response = await invite({ email: 'Lisa@Example.test' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('/join/');
    expect(sentMail().map((sent) => sent.to)).toEqual(['lisa@example.test']);
    expect(sentMail()[0]!.text).toMatch(/https:\/\/music\.example\/join\/[A-Za-z0-9_-]{20,}/);
    expect((await listOpenMemberInvites(testDb.db)).map((row) => row.email)).toEqual([
      'lisa@example.test',
    ]);
  });

  it('refuses an address a User already signs in with, in any casing', async () => {
    accountEmail(true);

    const response = await invite({ email: 'JOHN@example.test' });

    expect(response.status).toBe(409);
    expect(sentMail()).toEqual([]);
    expect(await listOpenMemberInvites(testDb.db)).toEqual([]);
  });

  it('refuses an address an open Invite already carries, in any casing', async () => {
    accountEmail(true);
    expect((await invite({ email: 'lisa@example.test' })).status).toBe(200);

    const response = await invite({ label: 'Lisa again', email: 'LISA@example.test' });

    expect(response.status).toBe(409);
    expect(sentMail()).toHaveLength(1);
    expect(await listOpenMemberInvites(testDb.db)).toHaveLength(1);
  });

  it('a mail that could not be sent leaves no open Invite', async () => {
    accountEmail(true);
    holder.mail = {
      send: vi.fn().mockRejectedValue(new EmailSendError('ECONNECTION')),
    } satisfies EmailSender;

    const response = await invite({ email: 'lisa@example.test' });

    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe(
      'The invite could not be sent. Try again later.',
    );
    expect(await listOpenMemberInvites(testDb.db)).toEqual([]);
  });

  it('with account email off, mints a copy-link Invite and refuses an address', async () => {
    accountEmail(false);

    const refused = await invite({ email: 'lisa@example.test' });
    const minted = await invite({});

    expect(refused.status).toBe(400);
    expect(minted.status).toBe(200);
    expect((await minted.json()).data.url).toMatch(/^https:\/\/music\.example\/join\//);
    expect(sentMail()).toEqual([]);
  });

  it('with account email on, refuses an Invite without an address', async () => {
    accountEmail(true);

    expect((await invite({})).status).toBe(400);
    expect(await listOpenMemberInvites(testDb.db)).toEqual([]);
  });
});
