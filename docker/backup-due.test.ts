import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { requestBackup, updateBackupSchedule, updateUsageLimits } from '@liedmotif/db';
import { DEFAULT_BACKUP_SCHEDULE } from '@liedmotif/shared';
import {
  connectTestDb,
  TEST_DATABASE_URL,
  truncateTables,
  type TestDb,
} from '@liedmotif/db/testing';

/** The exact file the backup sidecar runs through `psql` once a minute. */
const DUE_SQL = fileURLToPath(new URL('./backup-due.sql', import.meta.url));

describe.skipIf(!TEST_DATABASE_URL)('backup due query', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await connectTestDb('liedmotif-backup-due-test');
  }, 60_000);

  afterAll(async () => {
    await ctx?.pool.end();
  });

  beforeEach(async () => {
    await truncateTables(ctx.pool, ['app_settings']);
  });

  /** psql substitutes `-v now=<value>` as a quoted literal; this does the same. */
  async function dueAt(now: string): Promise<Record<string, unknown>> {
    const query = (await readFile(DUE_SQL, 'utf8')).replaceAll(":'now'", `'${now}'`);
    const { rows } = await ctx.pool.query(query);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function slotsAt(now: string): Promise<{ last_slot: unknown; next_slot: unknown }> {
    const { last_slot, next_slot } = await dueAt(now);
    return { last_slot, next_slot };
  }

  it('reads an instance with no backup settings as the shipped default schedule, in UTC', async () => {
    // A Wednesday; the default is Sunday 03:00.
    const { includeMedia, ...defaults } = DEFAULT_BACKUP_SCHEDULE;
    expect(await dueAt('2026-10-28T12:00:00Z')).toEqual({
      ...defaults,
      include_media: includeMedia,
      timezone: 'UTC',
      requested_at: null,
      last_slot: '2026-10-25T03:00:00Z',
      next_slot: '2026-11-01T03:00:00Z',
    });
  });

  it('reports a saved schedule, defaulting only the fields it lacks', async () => {
    await ctx.pool.query(
      `insert into app_settings (key, value) values ('backupSchedule', $1::jsonb)`,
      [JSON.stringify({ enabled: false, keep: 12, includeMedia: false })],
    );

    expect(await dueAt('2026-10-28T12:00:00Z')).toMatchObject({
      enabled: false,
      frequency: 'weekly',
      weekday: 0,
      hour: 3,
      keep: 12,
      include_media: false,
    });
  });

  it('reports the latest Back up now request, rounded up to the second', async () => {
    // Rounded up, "later than an attempt that started on a whole second" gives
    // the same answer as the full-precision timestamp.
    await requestBackup(ctx.db, new Date('2026-10-31T09:15:42.250Z'));
    expect((await dueAt('2026-10-31T09:16:00Z')).requested_at).toBe('2026-10-31T09:15:43Z');

    await requestBackup(ctx.db, new Date('2026-10-31T09:20:00.000Z'));
    expect((await dueAt('2026-10-31T09:21:00Z')).requested_at).toBe('2026-10-31T09:20:00Z');
  });

  it('holds back a request made after now until the next check', async () => {
    // The sidecar stamps an attempt with `now`; this request, rounded up, would
    // outlast that attempt and run a second time.
    await requestBackup(ctx.db, new Date('2026-10-31T12:00:00.700Z'));
    expect((await dueAt('2026-10-31T12:00:00Z')).requested_at).toBeNull();
    expect((await dueAt('2026-10-31T12:01:00Z')).requested_at).toBe('2026-10-31T12:00:01Z');
  });

  it('steps a weekly schedule by its weekday and a daily one by the day', async () => {
    // A Friday, 12:00 UTC.
    const now = '2026-10-30T12:00:00Z';

    await updateBackupSchedule(ctx.db, { frequency: 'weekly', weekday: 3, hour: 9 });
    expect(await slotsAt(now)).toEqual({
      last_slot: '2026-10-28T09:00:00Z',
      next_slot: '2026-11-04T09:00:00Z',
    });

    await updateBackupSchedule(ctx.db, { frequency: 'daily' });
    expect(await slotsAt(now)).toEqual({
      last_slot: '2026-10-30T09:00:00Z',
      next_slot: '2026-10-31T09:00:00Z',
    });
    expect(await slotsAt('2026-10-30T08:00:00Z')).toEqual({
      last_slot: '2026-10-29T09:00:00Z',
      next_slot: '2026-10-30T09:00:00Z',
    });
  });

  it('counts a slot that falls exactly on now as the last one, not the next', async () => {
    expect(await slotsAt('2026-10-25T03:00:00Z')).toEqual({
      last_slot: '2026-10-25T03:00:00Z',
      next_slot: '2026-11-01T03:00:00Z',
    });
    expect(await slotsAt('2026-10-25T02:59:59Z')).toEqual({
      last_slot: '2026-10-18T03:00:00Z',
      next_slot: '2026-10-25T03:00:00Z',
    });
  });

  it('keeps a Europe/Berlin slot at 03:00 local through both DST changes', async () => {
    await updateUsageLimits(ctx.db, { resetTimezone: 'Europe/Berlin' });

    // Spring forward on Sunday 2026-03-29: 03:00 CET (UTC+1) the week before,
    // 03:00 CEST (UTC+2) on the day.
    expect(await slotsAt('2026-03-29T00:30:00Z')).toEqual({
      last_slot: '2026-03-22T02:00:00Z',
      next_slot: '2026-03-29T01:00:00Z',
    });
    expect(await slotsAt('2026-03-29T01:00:00Z')).toEqual({
      last_slot: '2026-03-29T01:00:00Z',
      next_slot: '2026-04-05T01:00:00Z',
    });

    // Fall back on Sunday 2026-10-25: 03:00 CEST the week before, 03:00 CET on
    // the day. 01:30Z is the second pass through 02:30 local.
    expect(await slotsAt('2026-10-25T01:30:00Z')).toEqual({
      last_slot: '2026-10-18T01:00:00Z',
      next_slot: '2026-10-25T02:00:00Z',
    });
    expect(await slotsAt('2026-10-25T02:00:00Z')).toEqual({
      last_slot: '2026-10-25T02:00:00Z',
      next_slot: '2026-11-01T02:00:00Z',
    });
  });

  it('finds the weekday in local time when the zone is behind UTC', async () => {
    await updateUsageLimits(ctx.db, { resetTimezone: 'America/New_York' });
    await updateBackupSchedule(ctx.db, { weekday: 0, hour: 21 });

    // Sunday 21:00 EDT (UTC-4) is already Monday in UTC.
    expect(await slotsAt('2026-06-15T02:00:00Z')).toEqual({
      last_slot: '2026-06-15T01:00:00Z',
      next_slot: '2026-06-22T01:00:00Z',
    });
    expect(await slotsAt('2026-06-15T00:30:00Z')).toEqual({
      last_slot: '2026-06-08T01:00:00Z',
      next_slot: '2026-06-15T01:00:00Z',
    });
  });
});
