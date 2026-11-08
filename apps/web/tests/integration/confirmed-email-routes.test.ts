// Confirmed email through its routes: the signed-in send-confirm route, the
// unauthenticated confirm submit, and the mails an Admin email change sends.
// Against a real database with a recording mail sender, in both account-email
// modes.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { defaultHashPassword, upsertCredentialPassword, user, userProfiles } from '@liedmotif/db';
import {
  connectTestDb,
  createLogin,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { EmailSendError, type EmailSender } from '@liedmotif/providers/email';
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

const { POST: sendConfirmLink } = await import('@/app/api/settings/profile/confirm-link/route');
const { POST: confirmEmail } = await import('@/app/api/join/confirm/route');
const { POST: saveProfile } = await import('@/app/api/settings/profile/route');

const PUBLIC_URL = 'https://music.example';
const PASSWORD = 'Correct-Horse-42';
const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
// The send-confirm throttle lives for the process, so every test signs in as
// its own User.
let accountSeq = 0;

function accountEmail(on: boolean): void {
  vi.stubEnv('SMTP_URL', on ? 'smtp://mail.invalid:25' : '');
  vi.stubEnv('MAIL_FROM', on ? 'Liedmotif <liedmotif@example.test>' : '');
}

/** A signed-in User of `role` with a credential password and this browser's Login. */
async function signIn(role: 'admin' | 'member'): Promise<{ id: string; email: string }> {
  accountSeq += 1;
  const id = `${role}-${accountSeq}`;
  const email = `${id}@example.test`;
  await testDb.db.insert(user).values({ id, name: 'Lisa', email });
  await testDb.db.insert(userProfiles).values({ userId: id, role });
  await upsertCredentialPassword(testDb.db, id, await defaultHashPassword(PASSWORD));
  await createLogin(testDb.db, id, `this-browser-${id}`);
  holder.sessionUserId = id;
  return { id, email };
}

function post(path: string, body: unknown): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const requestConfirmLink = () => sendConfirmLink(post('/api/settings/profile/confirm-link', {}));

function changeEmail(email: string, name = 'Lisa'): Promise<Response> {
  return saveProfile(
    post('/api/settings/profile', {
      name,
      email,
      city: '',
      country: '',
      artistName: '',
      currentPassword: PASSWORD,
    }),
  );
}

async function stored(id: string) {
  const [row] = await testDb.db
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, id));
  return row;
}

async function confirmEmailOf(id: string): Promise<void> {
  await testDb.db.update(user).set({ emailVerified: true }).where(eq(user.id, id));
}

function sentTo(address: string) {
  return (holder.mail as ReturnType<typeof recordingEmailSender>).sent.filter(
    (sent) => sent.to === address,
  );
}

/** The token of the one confirm link in a mail body. */
function confirmTokenIn(text: string): string {
  const match = text.match(/https:\/\/music\.example\/confirm\/([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error('no confirm link in the mail');
  return match[1];
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('confirmed-email-routes-test');
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

describe.skipIf(skip)('confirmed email routes', () => {
  it('mails a Member a confirm link to their address, which confirms it exactly once', async () => {
    accountEmail(true);
    const member = await signIn('member');
    const mail = holder.mail as ReturnType<typeof recordingEmailSender>;

    expect((await requestConfirmLink()).status).toBe(200);
    expect(mail.sent.map((sent) => sent.to)).toEqual([member.email]);

    holder.sessionUserId = null;
    const token = confirmTokenIn(mail.sent[0]!.text);
    expect((await confirmEmail(post('/api/join/confirm', { token }))).status).toBe(200);
    expect((await stored(member.id))?.emailVerified).toBe(true);
    expect((await confirmEmail(post('/api/join/confirm', { token }))).status).toBe(404);
  });

  it('allows three confirm links per User per 15 minutes', async () => {
    accountEmail(true);
    await signIn('member');

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await requestConfirmLink()).status);

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((holder.mail as ReturnType<typeof recordingEmailSender>).sent).toHaveLength(3);
  });

  it('does not exist while account email is off', async () => {
    accountEmail(false);
    await signIn('admin');

    expect((await requestConfirmLink()).status).toBe(404);
    expect((holder.mail as ReturnType<typeof recordingEmailSender>).sent).toEqual([]);
  });

  it('an Admin email change unconfirms the address, mails a confirm link to the new one and a notice to the confirmed old one', async () => {
    accountEmail(true);
    const admin = await signIn('admin');
    await confirmEmailOf(admin.id);

    const response = await changeEmail('new@example.test');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, confirmLinkSent: true });
    expect(await stored(admin.id)).toEqual({ email: 'new@example.test', emailVerified: false });
    expect((holder.mail as ReturnType<typeof recordingEmailSender>).sent).toHaveLength(2);
    confirmTokenIn(sentTo('new@example.test')[0]!.text);
    expect(sentTo(admin.email)[0]?.text).toContain('new@example.test');
  });

  // An unconfirmed old address may be a setup placeholder or a typo that is
  // someone else's inbox.
  it('sends no notice to an old address that was never confirmed', async () => {
    accountEmail(true);
    await signIn('admin');

    expect((await changeEmail('new@example.test')).status).toBe(200);

    const mail = holder.mail as ReturnType<typeof recordingEmailSender>;
    expect(mail.sent.map((sent) => sent.to)).toEqual(['new@example.test']);
  });

  it('mails nothing when an Admin save keeps the address in another casing', async () => {
    accountEmail(true);
    const admin = await signIn('admin');
    await confirmEmailOf(admin.id);

    expect((await changeEmail(admin.email.toUpperCase(), 'Lisa M.')).status).toBe(200);

    expect((holder.mail as ReturnType<typeof recordingEmailSender>).sent).toEqual([]);
  });

  it('mails nothing on an Admin email change while account email is off', async () => {
    accountEmail(false);
    const admin = await signIn('admin');
    await confirmEmailOf(admin.id);

    expect((await changeEmail('new@example.test')).status).toBe(200);

    expect((await stored(admin.id))?.email).toBe('new@example.test');
    expect((holder.mail as ReturnType<typeof recordingEmailSender>).sent).toEqual([]);
  });

  it('keeps an Admin email change and its confirm link when the notice could not be sent', async () => {
    accountEmail(true);
    const admin = await signIn('admin');
    await confirmEmailOf(admin.id);
    const delivered = recordingEmailSender();
    holder.mail = {
      send: async (message) => {
        if (message.to === admin.email) throw new EmailSendError('ECONNECTION');
        await delivered.send(message);
      },
    } satisfies EmailSender;

    const response = await changeEmail('new@example.test');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, confirmLinkSent: true });
    expect((await stored(admin.id))?.email).toBe('new@example.test');
    expect(delivered.sent.map((sent) => sent.to)).toEqual(['new@example.test']);
  });

  it('keeps an Admin email change whose confirm mail could not be sent, and says so', async () => {
    accountEmail(true);
    const admin = await signIn('admin');
    holder.mail = {
      send: vi.fn().mockRejectedValue(new EmailSendError('ECONNECTION')),
    } satisfies EmailSender;

    const response = await changeEmail('new@example.test');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, confirmLinkSent: false });
    expect((await stored(admin.id))?.email).toBe('new@example.test');
  });
});
