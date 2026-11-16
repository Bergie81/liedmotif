import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BACKUP_SCHEDULE } from '@liedmotif/shared';
import { APP_SETTINGS_KEYS, appSettings, defaultUsageLimits, userProfiles, user } from '../schema';
import { seedAppSettings } from '../seed';
import { listPeople } from '../people/people-repo';
import { connectTestDb, TEST_DATABASE_URL, truncateTables, type TestDb } from '../test-support';
import {
  adminExists,
  assertCanCreateAdmin,
  createAdminProfile,
  getSetupState,
  isAdminUser,
  SetupLockedError,
} from './state';
import {
  getBackupRequest,
  getBackupSchedule,
  getInstanceSettings,
  getUsageLimits,
  markSetupComplete,
  requestBackup,
  updateBackupSchedule,
  updateUsageLimits,
  upsertInstanceSettings,
} from './settings';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

/** Create a real user row (admin profiles FK to it) and return its id. */
async function createUser(ctx: TestDb, id: string, email: string): Promise<string> {
  await ctx.db.insert(user).values({ id, name: 'Admin', email });
  return id;
}

describeIfDb('single-admin setup state + lock', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-setup-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    // Truncating `user` cascades to user_profiles/session/account.
    await truncateTables(ctx.pool, ['user', 'app_settings']);
  });

  it('reports setup as incomplete on a fresh instance', async () => {
    expect(await adminExists(ctx.db)).toBe(false);
    expect(await getSetupState(ctx.db, { signedIn: false })).toBe('setup');
  });

  it('allows the first admin, then locks setup', async () => {
    await assertCanCreateAdmin(ctx.db); // no throw on a fresh instance
    const userId = await createUser(ctx, 'admin-1', 'admin@example.test');
    await createAdminProfile(ctx.db, userId);

    expect(await adminExists(ctx.db)).toBe(true);
    expect(await listPeople(ctx.db, userId)).toMatchObject([
      { role: 'owner', name: 'Admin', sortOrder: 0 },
    ]);
    expect(await getSetupState(ctx.db, { signedIn: false })).toBe('login');
    expect(await getSetupState(ctx.db, { signedIn: true })).toBe('app');
  });

  it('rejects creating a second admin once one exists', async () => {
    const userId = await createUser(ctx, 'admin-1', 'admin@example.test');
    await createAdminProfile(ctx.db, userId);

    await expect(assertCanCreateAdmin(ctx.db)).rejects.toBeInstanceOf(SetupLockedError);
  });

  it('does not count a disabled admin (guards are correct-by-construction)', async () => {
    const userId = await createUser(ctx, 'admin-1', 'admin@example.test');
    await ctx.db.insert(userProfiles).values({ userId, role: 'admin', disabledAt: new Date() });

    expect(await adminExists(ctx.db)).toBe(false);
    expect(await isAdminUser(ctx.db, userId)).toBe(false);
    expect(await getSetupState(ctx.db, { signedIn: true })).toBe('setup');
  });

  it('enforces the single-admin invariant at the DB layer (race-proof)', async () => {
    await createUser(ctx, 'admin-1', 'admin-1@example.test');
    await createAdminProfile(ctx.db, 'admin-1');

    // A second admin row — as two concurrent first-run sign-ups would attempt —
    // must be rejected by the partial unique index, not just the logical check.
    // Drizzle wraps the driver error, so the SQLSTATE rides on the `cause`.
    const secondUserId = await createUser(ctx, 'admin-2', 'admin-2@example.test');
    const error = await ctx.db
      .insert(userProfiles)
      .values({ userId: secondUserId, role: 'admin' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error, 'expected the second admin insert to be rejected').toBeTruthy();
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('23505');
  });
});

describeIfDb('settings repository', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-settings-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings']);
  });

  it('round-trips instance settings and merges partial updates', async () => {
    await upsertInstanceSettings(ctx.db, {
      name: 'My Liedmotif',
      publicUrl: 'https://music.example',
    });
    // A partial update keeps unspecified fields.
    await upsertInstanceSettings(ctx.db, { name: 'Renamed' });

    const stored = await getInstanceSettings(ctx.db);
    expect(stored).toMatchObject({ name: 'Renamed', publicUrl: 'https://music.example' });
  });

  it('marks setup complete with a timestamp', async () => {
    await upsertInstanceSettings(ctx.db, { name: 'X', publicUrl: 'https://x' });
    await markSetupComplete(ctx.db, new Date('2026-06-28T10:00:00.000Z'));
    const stored = await getInstanceSettings(ctx.db);
    expect(stored?.setupCompletedAt).toBe('2026-06-28T10:00:00.000Z');
  });

  it('returns documented defaults for usage limits before any write', async () => {
    const limits = await getUsageLimits(ctx.db);
    expect(limits.dailyGenerationTasks).toBe(25);
    expect(limits.monthlyGenerationTasks).toBe(125);
    expect(limits.maxConcurrentJobs).toBe(1);
  });

  it('holds an install whose stored limits predate the ceiling switches to its caps', async () => {
    const {
      trackCeilingEnabled: _track,
      coverCeilingEnabled: _cover,
      ...legacy
    } = defaultUsageLimits();
    await ctx.db.insert(appSettings).values({ key: APP_SETTINGS_KEYS.usageLimits, value: legacy });

    expect(await getUsageLimits(ctx.db)).toMatchObject({
      trackCeilingEnabled: true,
      coverCeilingEnabled: true,
    });
  });

  it('seeds a new install with the Admin Track and Cover ceilings off', async () => {
    await seedAppSettings(ctx.db);

    expect(await getUsageLimits(ctx.db)).toMatchObject({
      trackCeilingEnabled: false,
      coverCeilingEnabled: false,
    });
  });

  it('updates usage limits and persists the merged object', async () => {
    const updated = await updateUsageLimits(ctx.db, { dailyGenerationTasks: 10 });
    expect(updated.dailyGenerationTasks).toBe(10);
    // Other documented defaults are preserved.
    expect(updated.monthlyGenerationTasks).toBe(125);

    const reread = await getUsageLimits(ctx.db);
    expect(reread.dailyGenerationTasks).toBe(10);
  });

  it('keeps both patches when two admin tabs save different limits at once', async () => {
    // Both pooled connections must already be established, otherwise the second
    // save waits out a connection handshake and the two never overlap.
    await Promise.all([ctx.pool.query('SELECT 1'), ctx.pool.query('SELECT 1')]);

    await Promise.all([
      updateUsageLimits(ctx.db, { dailyGenerationTasks: 7 }),
      updateUsageLimits(ctx.db, { monthlyGenerationTasks: 70 }),
    ]);

    const limits = await getUsageLimits(ctx.db);
    expect(limits.dailyGenerationTasks).toBe(7);
    expect(limits.monthlyGenerationTasks).toBe(70);
  });

  it('answers the default backup schedule before any write and merges a saved change', async () => {
    expect(await getBackupSchedule(ctx.db)).toEqual(DEFAULT_BACKUP_SCHEDULE);

    await updateBackupSchedule(ctx.db, { frequency: 'daily', hour: 22 });

    expect(await getBackupSchedule(ctx.db)).toEqual({
      ...DEFAULT_BACKUP_SCHEDULE,
      frequency: 'daily',
      hour: 22,
    });
  });

  it('records a Back up now request and reads it back', async () => {
    expect(await getBackupRequest(ctx.db)).toBeNull();

    await requestBackup(ctx.db, new Date('2026-10-31T09:15:42.250Z'));

    expect(await getBackupRequest(ctx.db)).toEqual({ requestedAt: '2026-10-31T09:15:42.250Z' });
  });
});
