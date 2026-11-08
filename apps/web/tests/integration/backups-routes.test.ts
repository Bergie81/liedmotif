// Settings → Backups API: the schedule round trip, Back up now, and the status
// and list read from the sidecar's files on the backups volume (fixture files
// here, written in the shapes the sidecar writes).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKUP_SCHEDULE } from '@liedmotif/shared';
import { getBackupRequest, getBackupSchedule, updateUsageLimits } from '@liedmotif/db';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

const holder = vi.hoisted(() => ({ db: null as unknown, admin: true }));
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }));
vi.mock('@/lib/session', () => ({
  getAdminSession: async () => (holder.admin ? { user: { id: 'admin-1' } } : null),
  getAppSession: async () => ({ user: { id: holder.admin ? 'admin-1' : 'member-1' } }),
}));

const backups = await import('@/app/api/settings/backups/route');
const backupRun = await import('@/app/api/settings/backups/run/route');

const skip = !TEST_DATABASE_URL;
let testDb: TestDb;
let backupDir: string;

function get() {
  return backups.GET(new Request('http://localhost/api/settings/backups'));
}

/** A `status.json` from a sidecar that checked in a few seconds ago. */
function freshStatus(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    checkedAt: new Date(now - 5_000).toISOString(),
    nextRunAt: new Date(now + 3 * 86_400_000).toISOString(),
    running: null,
    lastAttempt: {
      startedAt: new Date(now - 86_400_000).toISOString(),
      finishedAt: new Date(now - 86_000_000).toISOString(),
      ok: true,
    },
    lastSuccessAt: new Date(now - 86_000_000).toISOString(),
    overdue: false,
    diskBytes: 5_368_709_120,
    freeBytes: 42_949_672_960,
    encrypted: true,
    ...overrides,
  };
}

async function writeStatus(status: unknown) {
  await writeFile(join(backupDir, 'status.json'), JSON.stringify(status));
}

async function writeBackup(id: string, manifest: Record<string, unknown> | null) {
  await mkdir(join(backupDir, id, 'media'), { recursive: true });
  if (manifest) await writeFile(join(backupDir, id, 'manifest.json'), JSON.stringify(manifest));
}

beforeAll(async () => {
  if (skip) return;
  testDb = await connectTestDb('backups-routes-test');
  holder.db = testDb.db;
}, 60_000);

afterAll(async () => {
  if (skip) return;
  await testDb.pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await truncateTables(testDb.pool, ['app_settings']);
  await updateUsageLimits(testDb.db, { resetTimezone: 'Europe/Berlin' });
  holder.admin = true;
  backupDir = await mkdtemp(join(tmpdir(), 'liedmotif-backups-'));
  process.env.BACKUP_DIR = backupDir;
});

afterEach(async () => {
  if (skip) return;
  delete process.env.BACKUP_DIR;
  vi.unstubAllEnvs();
  await rm(backupDir, { recursive: true, force: true });
});

describe.skipIf(skip)('GET /api/settings/backups', () => {
  it('answers not-running with an empty list when BACKUP_DIR is not set', async () => {
    delete process.env.BACKUP_DIR;
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      schedule: DEFAULT_BACKUP_SCHEDULE,
      timezone: 'Europe/Berlin',
      service: 'not-running',
      status: null,
      backups: [],
    });
  });

  it('answers not-running with an empty list before the sidecar ever wrote its status', async () => {
    const { data } = await (await get()).json();
    expect(data.service).toBe('not-running');
    expect(data.status).toBeNull();
    expect(data.backups).toEqual([]);
  });

  it('reports the sidecar status and lists complete backups newest first', async () => {
    const status = freshStatus();
    await writeStatus(status);
    await writeBackup('liedmotif-backup-20261025T010002Z', {
      format: 1,
      createdAt: '2026-10-25T01:04:10Z',
      trigger: 'schedule',
      encrypted: true,
      includesMedia: true,
      dbBytes: 1_200,
      mediaBytes: 9_000,
      mediaFiles: 12,
    });
    await writeBackup('liedmotif-backup-20261101T020003Z', {
      format: 1,
      createdAt: '2026-11-01T02:01:00Z',
      trigger: 'manual',
      encrypted: false,
      includesMedia: false,
      mediaSkipped: 'object-storage',
      dbBytes: 1_300,
      mediaBytes: 0,
      mediaFiles: 0,
    });
    // Not listed: a run in progress, a folder without a manifest, a manifest
    // in an unknown format, and the flat files of the pre-folder sidecar.
    await writeBackup('.partial-20261102T020000Z', null);
    await writeBackup('liedmotif-backup-20261028T020000Z', null);
    await writeBackup('liedmotif-backup-20261029T020000Z', {
      format: 2,
      createdAt: '2026-10-29T02:01:00Z',
    });
    await writeFile(join(backupDir, 'liedmotif-db-20261001T020000Z.sql.gz'), 'legacy');

    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ service: 'healthy', status });
    expect(data.backups).toEqual([
      {
        id: 'liedmotif-backup-20261101T020003Z',
        createdAt: '2026-11-01T02:01:00Z',
        trigger: 'manual',
        encrypted: false,
        includesMedia: false,
        mediaSkipped: 'object-storage',
        dbBytes: 1_300,
        mediaBytes: 0,
        mediaFiles: 0,
      },
      {
        id: 'liedmotif-backup-20261025T010002Z',
        createdAt: '2026-10-25T01:04:10Z',
        trigger: 'schedule',
        encrypted: true,
        includesMedia: true,
        mediaSkipped: null,
        dbBytes: 1_200,
        mediaBytes: 9_000,
        mediaFiles: 12,
      },
    ]);
  });

  it('offers downloads only when the web server holds the backup passphrase', async () => {
    vi.stubEnv('BACKUP_ENCRYPTION_PASSPHRASE', '');
    expect((await (await get()).json()).data.downloadAvailable).toBe(false);
    vi.stubEnv('BACKUP_ENCRYPTION_PASSPHRASE', 'correct horse battery staple');
    expect((await (await get()).json()).data.downloadAvailable).toBe(true);
  });

  it('shows a failing sidecar with its error and retry time', async () => {
    const now = Date.now();
    const retryAt = new Date(now + 300_000).toISOString();
    await writeStatus(
      freshStatus({
        lastAttempt: {
          startedAt: new Date(now - 60_000).toISOString(),
          finishedAt: new Date(now - 55_000).toISOString(),
          ok: false,
          error: 'low-disk',
        },
        retryAt,
      }),
    );
    const { data } = await (await get()).json();
    expect(data.service).toBe('failing');
    expect(data.status.lastAttempt.error).toBe('low-disk');
    expect(data.status.retryAt).toBe(retryAt);
  });
});

describe.skipIf(skip)('PUT /api/settings/backups', () => {
  function put(body: unknown) {
    return backups.PUT(
      new Request('http://localhost/api/settings/backups', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    );
  }

  const daily = {
    enabled: true,
    frequency: 'daily',
    weekday: 3,
    hour: 23,
    keep: 52,
    includeMedia: false,
  };

  it('saves the schedule and reads it back', async () => {
    const res = await put(daily);
    expect(res.status).toBe(200);
    expect((await res.json()).data.schedule).toEqual(daily);
    expect((await (await get()).json()).data.schedule).toEqual(daily);
  });

  it('rejects out-of-range values, a partial schedule and unknown keys, saving nothing', async () => {
    for (const bad of [
      { ...daily, hour: 24 },
      { ...daily, weekday: 7 },
      { ...daily, keep: 0 },
      { ...daily, keep: 53 },
      { ...daily, frequency: 'hourly' },
      { enabled: false },
      { ...daily, timezone: 'UTC' },
    ]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect((await (await get()).json()).data.schedule).toEqual(DEFAULT_BACKUP_SCHEDULE);
  });
});

describe.skipIf(skip)('POST /api/settings/backups/run', () => {
  function run() {
    return backupRun.POST(
      new Request('http://localhost/api/settings/backups/run', { method: 'POST' }),
    );
  }

  it('records Back up now, which the status then shows as requested', async () => {
    await writeStatus(freshStatus());
    const before = Date.now();
    const res = await run();
    expect(res.status).toBe(200);
    const { requestedAt } = (await res.json()).data.request;
    expect(Date.parse(requestedAt)).toBeGreaterThanOrEqual(before);

    const { data } = await (await get()).json();
    expect(data.requestedAt).toBe(requestedAt);
    expect(data.service).toBe('requested');
  });

  it('answers 409 while a backup is running, and records nothing', async () => {
    await writeStatus(
      freshStatus({
        running: { startedAt: new Date(Date.now() - 30_000).toISOString(), trigger: 'schedule' },
      }),
    );
    const res = await run();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('conflict');
    expect((await (await get()).json()).data.requestedAt).toBeNull();
  });
});

describe.skipIf(skip)('Member access', () => {
  // `requireAdminOwnerId` refuses a Member exactly like a signed-out caller
  // (401), so probing an admin route tells a Member nothing.
  it('refuses a Member on every backups route, and writes nothing', async () => {
    holder.admin = false;
    await writeStatus(freshStatus());
    const responses = [
      await get(),
      await backups.PUT(
        new Request('http://localhost/api/settings/backups', {
          method: 'PUT',
          body: JSON.stringify({ ...DEFAULT_BACKUP_SCHEDULE, enabled: false }),
        }),
      ),
      await backupRun.POST(
        new Request('http://localhost/api/settings/backups/run', { method: 'POST' }),
      ),
    ];
    expect(responses.map((res) => res.status)).toEqual([401, 401, 401]);
    expect(await getBackupSchedule(testDb.db)).toEqual(DEFAULT_BACKUP_SCHEDULE);
    expect(await getBackupRequest(testDb.db)).toBeNull();
  });
});
