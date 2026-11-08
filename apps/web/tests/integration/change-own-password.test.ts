// Changing one's own password from Settings → Profile.
// Each account-email mode has exactly one path:
// with email on, a reset link mailed to the caller's Confirmed email; with it
// off, the current + new password form's route. Against a real database with a
// recording mail sender.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  defaultHashPassword,
  session,
  upsertCredentialPassword,
  user,
  userProfiles,
  verifyCredentialPassword,
} from '@liedmotif/db';
import {
  connectTestDb,
  createLogin,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { recordingEmailSender } from '@liedmotif/providers/testing';

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionUserId: null as string | null,
  mail: null as unknown,
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers', () => ({ getEmailSender: () => holder.mail }));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        holder.sessionUserId
          ? {
              session: { token: `this-browser-${holder.sessionUserId}` },
              user: { id: holder.sessionUserId },
            }
          : null,
    },
  }),
}));

const { POST: sendResetLink } = await import('@/app/api/settings/profile/reset-link/route');
const { POST: changePassword } = await import('@/app/api/settings/profile/password/route');

const PUBLIC_URL = 'https://music.example';
const PASSWORD = 'Correct-Horse-42';
const NEW_PASSWORD = 'Different-Horse-43';
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
// The throttles live for the process, so every test signs in as its own User.
let accountSeq = 0;

function accountEmail(on: boolean): void {
  vi.stubEnv('SMTP_URL', on ? 'smtp://mail.invalid:25' : '');
  vi.stubEnv('MAIL_FROM', on ? 'Liedmotif <liedmotif@example.test>' : '');
}

/** A signed-in Member with a credential password and this browser's Login. */
async function signIn(opts: { confirmed?: boolean } = {}): Promise<{ id: string; email: string }> {
  accountSeq += 1;
  const id = `member-${accountSeq}`;
  const email = `${id}@example.test`;
  await testDb.db.insert(user).values({ id, name: 'Lisa', email, emailVerified: !!opts.confirmed });
  await testDb.db.insert(userProfiles).values({ userId: id, role: 'member' });
  await upsertCredentialPassword(testDb.db, id, await defaultHashPassword(PASSWORD));
  await createLogin(testDb.db, id, `this-browser-${id}`);
  holder.sessionUserId = id;
  return { id, email };
}

function post(path: string, body: unknown, ip = '203.0.113.1'): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

const requestResetLink = () => sendResetLink(post('/api/settings/profile/reset-link', {}));

/** The form's submit, from the client IP the sign-in throttle keys on. */
function submitPasswordChange(
  body: { currentPassword: string; newPassword: string },
  ip: string,
): Promise<Response> {
  return changePassword(post('/api/settings/profile/password', body, ip));
}

async function liveLoginTokens(userId: string): Promise<string[]> {
  const rows = await testDb.db
    .select({ token: session.token })
    .from(session)
    .where(eq(session.userId, userId));
  return rows.map((row) => row.token);
}

function sentMail() {
  return (holder.mail as ReturnType<typeof recordingEmailSender>).sent;
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('change-own-password-test');
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
  holder.sessionUserId = null;
  holder.mail = recordingEmailSender();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.skipIf(skip)('email me a reset link (account email on)', () => {
  it('mails a confirmed caller a reset link to their own address', async () => {
    accountEmail(true);
    const member = await signIn({ confirmed: true });

    const response = await requestResetLink();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { sentTo: member.email } });
    expect(sentMail().map((sent) => sent.to)).toEqual([member.email]);
    expect(sentMail()[0]!.text).toMatch(/https:\/\/music\.example\/reset\/[A-Za-z0-9_-]+/);
  });

  it('refuses an unconfirmed caller and mails nothing', async () => {
    accountEmail(true);
    await signIn({ confirmed: false });

    const response = await requestResetLink();

    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toBe('Confirm your email first.');
    expect(sentMail()).toEqual([]);
  });

  it('allows three reset links per User per 15 minutes', async () => {
    accountEmail(true);
    await signIn({ confirmed: true });

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await requestResetLink()).status);

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(sentMail()).toHaveLength(3);
  });

  it('does not exist while account email is off', async () => {
    accountEmail(false);
    await signIn({ confirmed: true });

    expect((await requestResetLink()).status).toBe(404);
    expect(sentMail()).toEqual([]);
  });
});

describe.skipIf(skip)('change password with the current one (account email off)', () => {
  it('rotates the password, keeps this Login, and signs every other browser out', async () => {
    accountEmail(false);
    const member = await signIn();
    await createLogin(testDb.db, member.id, 'other-browser');

    const response = await submitPasswordChange(
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      '203.0.113.20',
    );

    expect(response.status).toBe(200);
    expect(await liveLoginTokens(member.id)).toEqual([`this-browser-${member.id}`]);
    expect(await verifyCredentialPassword(testDb.db, member.id, NEW_PASSWORD)).toBe(true);
    expect(await verifyCredentialPassword(testDb.db, member.id, PASSWORD)).toBe(false);
  });

  // The current password is all that stands between a stolen cookie and the
  // account, so guessing it spends the sign-in failure budget of the caller's IP.
  it('refuses a wrong current password and counts it against the sign-in budget', async () => {
    accountEmail(false);
    const member = await signIn();
    const guess = () =>
      submitPasswordChange(
        { currentPassword: 'Wrong-Horse-41', newPassword: NEW_PASSWORD },
        '203.0.113.21',
      );

    for (let i = 0; i < 10; i += 1) {
      const refused = await guess();
      expect(refused.status).toBe(400);
      expect((await refused.json()).error.message).toBe('That password is not correct.');
    }
    const right = await submitPasswordChange(
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      '203.0.113.21',
    );

    expect(right.status).toBe(429);
    expect(await verifyCredentialPassword(testDb.db, member.id, PASSWORD)).toBe(true);
  });

  it('holds the new password to the shared policy', async () => {
    accountEmail(false);
    const member = await signIn();

    const response = await submitPasswordChange(
      { currentPassword: PASSWORD, newPassword: 'aaaaaaaaaaaaaaaa' },
      '203.0.113.22',
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe(
      'Password needs a number, an uppercase letter, a special character.',
    );
    expect(await verifyCredentialPassword(testDb.db, member.id, PASSWORD)).toBe(true);
  });

  it('does not exist while account email is on', async () => {
    accountEmail(true);
    const member = await signIn();

    const response = await submitPasswordChange(
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      '203.0.113.23',
    );

    expect(response.status).toBe(404);
    expect(await verifyCredentialPassword(testDb.db, member.id, PASSWORD)).toBe(true);
  });
});
