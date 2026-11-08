// Forgot password: the deferred
// mint-and-mail, and the public route that answers before it runs. Against a
// real database with a recording mail sender.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findClaimableLink, resetPasswordWithToken, user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { recordingEmailSender } from '@liedmotif/providers/testing';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  mail: null as unknown,
  dbReads: 0,
  /** Work the route handed to `after()`, run only when a test says so. */
  deferred: [] as Array<() => unknown>,
}));

vi.mock('@/lib/db', () => ({
  getDb: () => {
    holder.dbReads += 1;
    return holder.db;
  },
}));
vi.mock('@/lib/providers', () => ({ getEmailSender: () => holder.mail }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => unknown) => {
    holder.deferred.push(task);
  },
}));

const { mailForgotPasswordLink } = await import('@/lib/account-mail');
const { POST: forgotPassword } = await import('@/app/api/join/forgot/route');

const PUBLIC_URL = 'https://music.example';
const HOUR_MS = 60 * 60 * 1_000;
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
// The route's throttles live for the process: every request comes from its own
// IP unless a test is about the IP budget, and each route test asks for
// addresses no other route test uses.
let ipSeq = 0;

const sentMail = () => (holder.mail as ReturnType<typeof recordingEmailSender>).sent;

function accountEmail(on: boolean): void {
  vi.stubEnv('SMTP_URL', on ? 'smtp://mail.invalid:25' : '');
  vi.stubEnv('MAIL_FROM', on ? 'Liedmotif <liedmotif@example.test>' : '');
}

function requestReset(email: string, ip = `198.51.100.${(ipSeq += 1)}`): Promise<Response> {
  return forgotPassword(
    new Request(`${PUBLIC_URL}/api/join/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify({ email }),
    }),
  );
}

/** Status and body exactly as the caller receives them. */
async function reply(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

async function runDeferred(): Promise<void> {
  for (const task of holder.deferred.splice(0)) await task();
}

/** A User with a stored (lowercased) address, its confirmed state, and its profile. */
async function account(
  id: string,
  opts: { confirmed: boolean; disabled?: boolean },
): Promise<string> {
  const email = `${id}@example.test`;
  await testDb.db.insert(user).values({ id, name: id, email, emailVerified: opts.confirmed });
  await testDb.db.insert(userProfiles).values({
    userId: id,
    role: 'member',
    disabledAt: opts.disabled ? new Date() : null,
  });
  return email;
}

/** The token of the one reset link in a mail body. */
function resetTokenIn(text: string): string {
  const match = text.match(/https:\/\/music\.example\/reset\/([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error('no reset link in the mail');
  return match[1];
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('forgot-password-test');
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
  holder.dbReads = 0;
  holder.deferred = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(skip)('the forgot-password mail', () => {
  it('mails a confirmed, enabled User a reset link that works for 1 hour', async () => {
    const email = await account('lisa', { confirmed: true });
    const now = new Date('2026-10-24T10:00:00.000Z');

    await mailForgotPasswordLink(testDb.db, { email: 'Lisa@Example.test', now });

    expect(sentMail().map((sent) => sent.to)).toEqual([email]);
    const token = resetTokenIn(sentMail()[0]!.text);
    const later = (ms: number) => new Date(now.getTime() + ms);
    expect(
      await findClaimableLink(testDb.db, {
        kind: 'password_reset',
        token,
        now: later(HOUR_MS + 1),
      }),
    ).toBeNull();
    expect(
      await resetPasswordWithToken(testDb.db, {
        token,
        newPassword: 'Correct-Horse-42',
        hashPassword: async (password) => `fake-hash(${password})`,
        now: later(HOUR_MS - 60_000),
      }),
    ).toEqual({ ok: true, userId: 'lisa' });
  });

  it('mails nobody for an unknown, unconfirmed, or Disabled address', async () => {
    const unconfirmed = await account('ben', { confirmed: false });
    const disabled = await account('mara', { confirmed: true, disabled: true });

    for (const email of ['nobody@example.test', unconfirmed, disabled]) {
      await mailForgotPasswordLink(testDb.db, { email });
    }

    expect(sentMail()).toEqual([]);
  });

  it('a second request voids the first link', async () => {
    const email = await account('lisa', { confirmed: true });

    await mailForgotPasswordLink(testDb.db, { email });
    await mailForgotPasswordLink(testDb.db, { email });

    const [first, second] = sentMail().map((sent) => resetTokenIn(sent.text));
    expect(
      await findClaimableLink(testDb.db, { kind: 'password_reset', token: first! }),
    ).toBeNull();
    expect(
      await findClaimableLink(testDb.db, { kind: 'password_reset', token: second! }),
    ).not.toBeNull();
  });
});

describe.skipIf(skip)('POST /api/join/forgot', () => {
  it('answers every address alike before looking anything up, and mails only the confirmed, enabled account', async () => {
    accountEmail(true);
    const valid = await account('lisa', { confirmed: true });
    const unconfirmed = await account('ben', { confirmed: false });
    const disabled = await account('mara', { confirmed: true, disabled: true });

    const replies = [];
    for (const email of [valid, unconfirmed, disabled, 'nobody@example.test']) {
      replies.push(await reply(await requestReset(email)));
    }

    expect(replies[0]?.status).toBe(200);
    expect(new Set(replies.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(holder.dbReads).toBe(0);
    expect(sentMail()).toEqual([]);

    await runDeferred();
    expect(sentMail().map((sent) => sent.to)).toEqual([valid]);
  });

  it('past three requests an hour, an address gets the same reply and no more mail', async () => {
    accountEmail(true);
    const email = await account('zoe', { confirmed: true });

    const replies = [];
    for (let i = 0; i < 4; i += 1) replies.push(await reply(await requestReset(email)));
    await runDeferred();

    expect(new Set(replies.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(sentMail()).toHaveLength(3);
  });

  it('throttles one IP across addresses', async () => {
    accountEmail(true);

    const statuses = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await requestReset(`spray-${i}@example.test`, '203.0.113.40')).status);
    }

    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  // Nobody awaits the deferred work, so an escaped rejection reaches Next's
  // error log raw — and a failed query's message carries its parameters.
  it('swallows a failing lookup and logs no address', async () => {
    accountEmail(true);
    const email = 'kim@example.test';
    holder.db = {
      select() {
        throw new Error(`Failed query: select "id" from "user"\nparams: ${email}`);
      },
    };
    const logged: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
      logged.push(String(line));
      return true;
    });

    try {
      expect((await requestReset(email)).status).toBe(200);
      await runDeferred();
    } finally {
      stdout.mockRestore();
      holder.db = testDb.db;
    }

    expect(logged.join('')).toContain('forgot-password mail failed');
    expect(logged.join('')).not.toContain(email);
  });

  it('does not exist while account email is off', async () => {
    accountEmail(false);
    const email = await account('lisa', { confirmed: true });

    expect((await requestReset(email)).status).toBe(404);
    expect(holder.deferred).toEqual([]);
  });
});
