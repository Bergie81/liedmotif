// `GET /api/alerts/check` end to end against a real database: the token gate, the
// three sources, delivery to the webhook and Account email, and what persists.
// `fetch` and the mail sender are recorded; nothing leaves the machine.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from 'graphile-worker';
import {
  readInstanceAlertsState,
  refreshStorageUsage,
  updateUsageLimits,
  user,
  userProfiles,
  writeInstanceAlertsState,
  writeWorkerHeartbeat,
  type Database,
  type InstanceAlertsState,
} from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';
import { EmailSendError, type EmailMessage } from '@liedmotif/providers/email';
import { recordingEmailSender } from '@liedmotif/providers/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, mail: null as unknown }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/providers', () => ({ getEmailSender: () => holder.mail }));

const { GET } = await import('@/app/api/alerts/check/route');

const TOKEN = 'alert-check-token-for-tests';
const WEBHOOK_URL = 'http://receiver.lan:2586/hook-path-secret?auth=receiver-query-secret';
const ADMIN_EMAIL = 'admin-address@example.test';
const SMTP_URL = 'smtp://mail-user:smtp-password-sentinel@mail.invalid:25';
const MINUTE = 60_000;

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;

/** Every webhook POST this test observed. */
const posts: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
let webhookReply: () => Promise<Response> = async () => new Response(null, { status: 200 });

function arm(destinations: { webhook?: boolean; email?: boolean }): void {
  vi.stubEnv('ALERT_CHECK_TOKEN', TOKEN);
  vi.stubEnv('ALERT_WEBHOOK_URL', destinations.webhook ? WEBHOOK_URL : '');
  vi.stubEnv('SMTP_URL', destinations.email ? SMTP_URL : '');
  vi.stubEnv('MAIL_FROM', destinations.email ? 'Liedmotif <liedmotif@example.test>' : '');
}

function check(token: string | null = TOKEN): Promise<Response> {
  return GET(
    new Request('http://localhost:2206/api/alerts/check', {
      headers: token === null ? {} : { 'x-alert-token': token },
    }),
  );
}

async function checkBody(token?: string | null) {
  const response = await check(token);
  return { status: response.status, body: await response.json() };
}

function sentMail(): EmailMessage[] {
  return (holder.mail as ReturnType<typeof recordingEmailSender>).sent;
}

async function heartbeat(ageMs: number): Promise<void> {
  const ts = new Date(Date.now() - ageMs).toISOString();
  await writeWorkerHeartbeat(testDb.db, {
    ts,
    pid: 1,
    state: 'ready',
    concurrency: 2,
    startedAt: ts,
  });
}

const workerIsHealthy = () => heartbeat(1_000);
const workerIsDead = () => heartbeat(30 * MINUTE);

async function seedAdmin(input: { confirmed: boolean }): Promise<void> {
  await testDb.db
    .insert(user)
    .values({ id: 'admin', name: 'Lisa', email: ADMIN_EMAIL, emailVerified: input.confirmed });
  await testDb.db.insert(userProfiles).values({ userId: 'admin', role: 'admin' });
}

/** A database whose every read and write throws, as during a Postgres outage. */
const BROKEN_DB = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      };
    },
  },
);

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('alerts-admin-about-instance-failures-test');
  await runMigrations({ connectionString: TEST_DATABASE_URL! });
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  holder.db = testDb.db;
  holder.mail = recordingEmailSender();
  await truncateTables(testDb.pool, ['user', 'app_settings']);
  await testDb.pool.query('delete from graphile_worker._private_jobs');
  posts.length = 0;
  webhookReply = async () => new Response(null, { status: 200 });
  vi.stubEnv('APP_PUBLIC_URL', 'https://music.example:8443');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url, init, body: JSON.parse(String(init.body)) });
      return webhookReply();
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.skipIf(skip)('the token gate', () => {
  it('answers 404 with no token set, even with a webhook and account email configured', async () => {
    arm({ webhook: true, email: true });
    vi.stubEnv('ALERT_CHECK_TOKEN', '');
    await seedAdmin({ confirmed: true });
    await workerIsDead();

    expect((await check()).status).toBe(404);
    expect(posts).toHaveLength(0);
    expect(sentMail()).toHaveLength(0);
  });

  it('refuses a missing and a wrong token identically, without dispatching', async () => {
    arm({ webhook: true });
    await workerIsDead();

    const missing = await check(null);
    const wrong = await check('not-the-token');
    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(await missing.text()).toBe(await wrong.text());
    expect(posts).toHaveLength(0);
  });
});

describe.skipIf(skip)('webhook delivery', () => {
  it('answers 200 with an empty report when everything is healthy', async () => {
    arm({ webhook: true });
    await workerIsHealthy();

    const { status, body } = await checkBody();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      firing: [],
      dispatched: [],
      dispatchFailures: 0,
      destinations: { webhook: 'on', email: 'off' },
    });
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
    expect(posts).toHaveLength(0);
  });

  it('announces a stale heartbeat once, with one POST carrying the aliased shape', async () => {
    arm({ webhook: true });
    await workerIsDead();

    const { status, body } = await checkBody();
    expect(status).toBe(200);
    expect(body.firing).toEqual([
      { condition: 'worker-heartbeat', severity: 'critical', message: expect.any(String) },
    ]);
    expect(body.dispatched).toEqual([
      { condition: 'worker-heartbeat', severity: 'critical', state: 'firing' },
    ]);

    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.url).toBe(WEBHOOK_URL);
    expect(post.init.method).toBe('POST');
    expect(post.body).toMatchObject({
      instance: 'music.example:8443',
      condition: 'worker-heartbeat',
      severity: 'critical',
      state: 'firing',
    });
    expect(post.body.message).toMatch(/30 minutes ago/);
    expect(post.body.text).toBe(post.body.message);
    expect(post.body.content).toBe(post.body.message);
    expect(post.body.title).toEqual(expect.any(String));
    expect(post.body.at).toEqual(expect.any(String));
    expect(post.body).not.toHaveProperty('since');
    const headers = new Headers(post.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('title')).toBe(post.body.title);
    expect(headers.get('priority')).toBe('urgent');
  });

  it('stays quiet on the next run, then sends one recovery, then nothing', async () => {
    arm({ webhook: true });
    await workerIsDead();
    await check();
    posts.length = 0;

    const repeat = await checkBody();
    expect(repeat.status).toBe(200);
    expect(repeat.body.firing).toHaveLength(1);
    expect(posts).toHaveLength(0);

    await workerIsHealthy();
    const recovery = await checkBody();
    expect(recovery.status).toBe(200);
    expect(recovery.body.firing).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ condition: 'worker-heartbeat', state: 'recovered' });
    expect(posts[0]!.body.since).toEqual(expect.any(String));
    expect(new Headers(posts[0]!.init.headers).get('priority')).toBe('default');

    posts.length = 0;
    expect((await check()).status).toBe(200);
    expect(posts).toHaveLength(0);
  });

  it('reads all three real sources: never-reported, a job out of attempts, a full quota', async () => {
    arm({ webhook: true });
    await testDb.pool.query(`select graphile_worker.add_job('alerts-test-job')`);
    await testDb.pool.query('update graphile_worker._private_jobs set attempts = max_attempts');
    await refreshStorageUsage(testDb.db);
    await updateUsageLimits(testDb.db, { storageQuotaBytes: 0 });

    const { status, body } = await checkBody();
    expect(status).toBe(200);
    expect(body.firing).toEqual([
      { condition: 'worker-heartbeat', severity: 'critical', message: expect.any(String) },
      { condition: 'failed-jobs', severity: 'warning', message: expect.any(String) },
      { condition: 'storage-quota', severity: 'critical', message: expect.any(String) },
    ]);
    expect(posts.map((post) => post.body.condition)).toEqual([
      'worker-heartbeat',
      'failed-jobs',
      'storage-quota',
    ]);
    expect(new Headers(posts[1]!.init.headers).get('priority')).toBe('high');
  });

  it.each([
    ['refuses', async () => new Response(null, { status: 500 })],
    [
      'cannot be reached',
      async () => {
        throw new TypeError(`fetch failed: ${WEBHOOK_URL}`);
      },
    ],
  ])('answers 502 and sends again next run when the only destination %s', async (_, reply) => {
    arm({ webhook: true });
    await workerIsDead();
    webhookReply = reply;

    const { status, body } = await checkBody();
    expect(status).toBe(502);
    expect(body.dispatchFailures).toBe(1);
    expect(body.dispatched).toEqual([]);
    expect(await readInstanceAlertsState(testDb.db)).toEqual({});

    posts.length = 0;
    webhookReply = async () => new Response(null, { status: 200 });
    expect((await check()).status).toBe(200);
    expect(posts).toHaveLength(1);
  });

  it('never logs the webhook URL when a POST fails', async () => {
    arm({ webhook: true });
    await workerIsDead();
    webhookReply = async () => {
      throw new TypeError(`fetch failed: ${WEBHOOK_URL}`);
    };
    const output: string[] = [];
    const capture = (chunk: unknown) => {
      output.push(String(chunk));
      return true;
    };
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void capture(args.join(' '))),
    );

    await check();

    stdout.mockRestore();
    stderr.mockRestore();
    for (const spy of consoleSpies) spy.mockRestore();
    const logged = output.join('\n');
    expect(logged).toContain('worker-heartbeat');
    expect(logged).not.toContain('hook-path-secret');
    expect(logged).not.toContain('receiver-query-secret');
  });
});

describe.skipIf(skip)('email delivery', () => {
  it('mails the Confirmed email and posts nothing on an email-only Instance', async () => {
    arm({ email: true });
    await seedAdmin({ confirmed: true });
    await workerIsDead();

    const { status, body } = await checkBody();
    expect(status).toBe(200);
    expect(body.destinations).toEqual({ webhook: 'off', email: 'on' });
    expect(posts).toHaveLength(0);
    expect(sentMail()).toHaveLength(1);
    const mail = sentMail()[0]!;
    expect(mail.to).toBe(ADMIN_EMAIL);
    expect(mail.subject).toContain('Liedmotif');
    expect(mail.text).toMatch(/30 minutes ago/);
    expect(mail.text).toContain('music.example:8443');
    expect(mail.text).not.toMatch(/http/i);
  });

  it('answers 502 on every run when an email-only Admin has no Confirmed email', async () => {
    arm({ email: true });
    await seedAdmin({ confirmed: false });
    await workerIsHealthy();

    const healthy = await checkBody();
    expect(healthy.status).toBe(502);
    expect(healthy.body.firing).toEqual([]);
    expect(healthy.body.destinations).toEqual({ webhook: 'off', email: 'no-confirmed-address' });

    await workerIsDead();
    const firing = await check();
    const text = await firing.text();
    expect(firing.status).toBe(502);
    expect(JSON.parse(text).firing).toHaveLength(1);
    expect(JSON.parse(text).destinations.email).toBe('no-confirmed-address');
    expect(text).not.toContain(ADMIN_EMAIL);

    expect(sentMail()).toHaveLength(0);
    expect(await readInstanceAlertsState(testDb.db)).toEqual({});
  });

  it('does not mail a Disabled Admin', async () => {
    arm({ email: true });
    await seedAdmin({ confirmed: true });
    await testDb.pool.query('update user_profiles set disabled_at = now()');
    await workerIsDead();

    const { status, body } = await checkBody();
    expect(status).toBe(502);
    expect(body.destinations.email).toBe('no-confirmed-address');
    expect(sentMail()).toHaveLength(0);
  });
});

describe.skipIf(skip)('webhook and email together', () => {
  it('sends one POST and one mail per change', async () => {
    arm({ webhook: true, email: true });
    await seedAdmin({ confirmed: true });
    await workerIsDead();

    const { status, body } = await checkBody();
    expect(status).toBe(200);
    expect(body.destinations).toEqual({ webhook: 'on', email: 'on' });
    expect(posts).toHaveLength(1);
    expect(sentMail()).toHaveLength(1);
  });

  it('follows the webhook and reports the missing address when there is no Confirmed email', async () => {
    arm({ webhook: true, email: true });
    await seedAdmin({ confirmed: false });
    await workerIsDead();

    const { status, body } = await checkBody();
    expect(status).toBe(200);
    expect(body.destinations).toEqual({ webhook: 'on', email: 'no-confirmed-address' });
    expect(posts).toHaveLength(1);
    expect(sentMail()).toHaveLength(0);
  });

  it('answers 502 when mail fails but the webhook delivers, persists, and stays quiet next run', async () => {
    arm({ webhook: true, email: true });
    await seedAdmin({ confirmed: true });
    await workerIsDead();
    holder.mail = {
      send: async () => {
        throw new EmailSendError('ECONNECTION');
      },
    };

    const { status, body } = await checkBody();
    expect(status).toBe(502);
    expect(body.dispatchFailures).toBe(1);
    expect(body.dispatched).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(await readInstanceAlertsState(testDb.db)).toHaveProperty('worker-heartbeat');

    posts.length = 0;
    expect((await check()).status).toBe(200);
    expect(posts).toHaveLength(0);
  });

  it('answers 502 when the webhook fails but mail delivers, and persists', async () => {
    arm({ webhook: true, email: true });
    await seedAdmin({ confirmed: true });
    await workerIsDead();
    webhookReply = async () => new Response(null, { status: 503 });

    expect((await check()).status).toBe(502);
    expect(sentMail()).toHaveLength(1);
    expect(await readInstanceAlertsState(testDb.db)).toHaveProperty('worker-heartbeat');
  });

  it('persists nothing when any notification reached no destination', async () => {
    arm({ webhook: true });
    await workerIsDead();
    await testDb.pool.query(`select graphile_worker.add_job('alerts-test-job')`);
    await testDb.pool.query('update graphile_worker._private_jobs set attempts = max_attempts');
    let replies = 0;
    webhookReply = async () => new Response(null, { status: replies++ === 0 ? 200 : 500 });

    const { status, body } = await checkBody();
    expect(status).toBe(502);
    expect(body.dispatched).toHaveLength(1);
    expect(await readInstanceAlertsState(testDb.db)).toEqual({});
  });
});

describe.skipIf(skip)('when the database cannot be used', () => {
  it('answers 503 with no dispatch and state untouched, never reading it as "never reported"', async () => {
    arm({ webhook: true });
    const announced: InstanceAlertsState = {
      'failed-jobs': { severity: 'warning', since: '2026-11-01T00:00:00.000Z' },
    };
    await writeInstanceAlertsState(testDb.db, announced);
    holder.db = BROKEN_DB;

    const { status, body } = await checkBody();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(posts).toHaveLength(0);
    expect(await readInstanceAlertsState(testDb.db)).toEqual(announced);
  });

  it('answers 503 when the state cannot be saved, so the next run sends again', async () => {
    arm({ webhook: true });
    await workerIsDead();
    holder.db = new Proxy(testDb.db, {
      get(target, property) {
        if (property === 'insert') {
          return () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
          };
        }
        return Reflect.get(target, property);
      },
    }) as Database;

    expect((await check()).status).toBe(503);
    expect(posts).toHaveLength(1);
    expect(await readInstanceAlertsState(testDb.db)).toEqual({});
  });
});

describe.skipIf(skip)('what leaves the Instance', () => {
  it('carries no provider key, SMTP URL, webhook URL, or Admin address in any response or message', async () => {
    arm({ webhook: true, email: true });
    vi.stubEnv('SUNO_API_KEY', 'suno-key-sentinel');
    await seedAdmin({ confirmed: true });
    await workerIsDead();

    const text = await (await check()).text();
    const everything = [
      text,
      ...posts.map((post) => String(post.init.body)),
      ...sentMail().map((mail) => `${mail.subject}\n${mail.text}`),
    ];
    expect(posts).toHaveLength(1);
    expect(sentMail()).toHaveLength(1);
    for (const surface of everything) {
      expect(surface).not.toContain('suno-key-sentinel');
      expect(surface).not.toContain('smtp-password-sentinel');
      expect(surface).not.toContain('hook-path-secret');
      expect(surface).not.toContain(TOKEN);
      expect(surface).not.toContain(ADMIN_EMAIL);
    }
  });
});
