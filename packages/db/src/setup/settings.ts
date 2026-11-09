// Settings repository: typed reads/writes over the `app_settings` key/value store.
//
// Each settings object lives under one key as a single typed JSON value, with no
// dedicated table (see `schema/settings.ts`): `instance` (name / public URL,
// recorded at first run), `usageLimits` (the Admin's cost-control object),
// `coverArt`, `memberPool` (the shared Member ceiling), `unitCosts`
// (the Admin's price per Track / Cover), `backupSchedule` / `backupRequest`
// (instance backups), `assistant` (the Assistant access every Member starts
// from), and `instanceAlerts`. Defaults are merged on read. Writes
// patch the stored jsonb rather than restating it, except the two that replace a
// whole value: `backupRequest`, and `instanceAlerts`, where a recovery removes keys
// a patch could not.

import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_ASSISTANT_ACCESS,
  DEFAULT_BACKUP_SCHEDULE,
  DEFAULT_MEMBERS_POOL,
  DEFAULT_UNIT_COSTS,
  type AssistantAccess,
  type BackupRequest,
  type BackupSchedule,
  type MembersPool,
  type UnitCosts,
} from '@liedmotif/shared';
import type { Database } from '../client';
import type { DbOrTx } from '../transactions';
import { APP_SETTINGS_KEYS, appSettings, defaultUsageLimits } from '../schema';
import type {
  CoverArtSettings,
  InstanceAlertsState,
  InstanceSettings,
  UsageLimits,
} from '../schema/types';

/** Read one settings value by key, or `null` when it has never been written. */
export async function readSetting<T>(db: DbOrTx, key: string): Promise<T | null> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return (rows[0]?.value as T | undefined) ?? null;
}

/** Upsert one settings value by key (insert, or overwrite the existing value). */
export async function writeSetting(db: Database, key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * One settings object's effective value: the stored object over the shipped
 * defaults. Spreading over defaults makes a later shape extension safe — a row
 * written before a new field existed still reads complete.
 */
async function getSetting<T extends object>(db: DbOrTx, key: string, defaults: T): Promise<T> {
  const stored = await readSetting<Partial<T>>(db, key);
  return { ...defaults, ...stored };
}

/**
 * Apply a partial patch to one settings object and return the full effective
 * result. A single atomic upsert: the conflict branch merges ONLY the patch keys
 * over the stored jsonb (`value || patch`), so two concurrent patches to
 * different fields both survive — including when they race on creating the very
 * first row. The caller (route) has already validated the patch.
 */
async function updateSetting<T extends object>(
  db: DbOrTx,
  key: string,
  defaults: T,
  patch: Partial<T>,
): Promise<T> {
  const [row] = await db
    .insert(appSettings)
    .values({ key, value: { ...defaults, ...patch } })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: sql`${appSettings.value} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning({ value: appSettings.value });
  return { ...defaults, ...(row!.value as Partial<T>) };
}

const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = { name: '', publicUrl: '' };

/** The current instance configuration, or `null` before the wizard writes it. */
export async function getInstanceSettings(db: Database): Promise<InstanceSettings | null> {
  return readSetting<InstanceSettings>(db, APP_SETTINGS_KEYS.instance);
}

/**
 * Merge a partial instance configuration over whatever is stored and persist it.
 * Returns the resulting full object. Missing required fields default to empty so a
 * first write is well-formed.
 */
export async function upsertInstanceSettings(
  db: Database,
  patch: Partial<InstanceSettings>,
): Promise<InstanceSettings> {
  return updateSetting(db, APP_SETTINGS_KEYS.instance, DEFAULT_INSTANCE_SETTINGS, patch);
}

/** Mark setup complete with an ISO timestamp (convenience marker for diagnostics). */
export async function markSetupComplete(db: Database, at: Date = new Date()): Promise<void> {
  await upsertInstanceSettings(db, { setupCompletedAt: at.toISOString() });
}

/** What Instance alerts last announced; empty until something has been. */
export async function readInstanceAlertsState(db: DbOrTx): Promise<InstanceAlertsState> {
  return getSetting<InstanceAlertsState>(db, APP_SETTINGS_KEYS.instanceAlerts, {});
}

export async function writeInstanceAlertsState(
  db: Database,
  state: InstanceAlertsState,
): Promise<void> {
  await writeSetting(db, APP_SETTINGS_KEYS.instanceAlerts, state);
}

/** The effective usage limits — stored values over the documented defaults. */
export async function getUsageLimits(db: Database): Promise<UsageLimits> {
  return getSetting(db, APP_SETTINGS_KEYS.usageLimits, defaultUsageLimits());
}

/** An unset `coverArt` key means `poster_art` (Artistic), no Custom style. */
const DEFAULT_COVER_ART_SETTINGS: CoverArtSettings = {
  defaultStyle: 'poster_art',
  customStyleDefinition: '',
  promptEnhancementEnabled: true,
  useStandardCoverArt: false,
};

/** The stored cover-art preferences over the shipped defaults. */
export async function getCoverArtSettings(db: Database): Promise<CoverArtSettings> {
  return getSetting(db, APP_SETTINGS_KEYS.coverArt, DEFAULT_COVER_ART_SETTINGS);
}

/** Merge a partial cover-art change over the current settings and persist it. */
export async function updateCoverArtSettings(
  db: Database,
  patch: Partial<CoverArtSettings>,
): Promise<CoverArtSettings> {
  return updateSetting(db, APP_SETTINGS_KEYS.coverArt, DEFAULT_COVER_ART_SETTINGS, patch);
}

/**
 * The effective Members Pool — the shared ceiling over ALL Members,
 * stored values over the shipped defaults. Window rollover follows the Admin's
 * `usageLimits.resetTimezone`; the Pool deliberately has none of its own.
 */
export async function getMembersPool(db: DbOrTx): Promise<MembersPool> {
  return getSetting(db, APP_SETTINGS_KEYS.memberPool, DEFAULT_MEMBERS_POOL);
}

/** Merge a partial Pool change over the current Pool and persist it. */
export async function updateMembersPool(
  db: Database,
  patch: Partial<MembersPool>,
): Promise<MembersPool> {
  return updateSetting(db, APP_SETTINGS_KEYS.memberPool, DEFAULT_MEMBERS_POOL, patch);
}

/**
 * What every Member gets of the Assistant unless the Admin gave them values of
 * their own: stored values over the shipped default.
 */
export async function getAssistantAccess(db: DbOrTx): Promise<AssistantAccess> {
  return getSetting(db, APP_SETTINGS_KEYS.assistant, DEFAULT_ASSISTANT_ACCESS);
}

/** Merge a partial change over the instance's Assistant default and persist it. */
export async function updateAssistantAccess(
  db: Database,
  patch: Partial<AssistantAccess>,
): Promise<AssistantAccess> {
  return updateSetting(db, APP_SETTINGS_KEYS.assistant, DEFAULT_ASSISTANT_ACCESS, patch);
}

/** The Admin's Unit costs — stored prices over the shipped defaults. */
export async function getUnitCosts(db: DbOrTx): Promise<UnitCosts> {
  return getSetting(db, APP_SETTINGS_KEYS.unitCosts, DEFAULT_UNIT_COSTS);
}

/** Merge a partial price change over the current Unit costs and persist it. */
export async function updateUnitCosts(db: Database, patch: Partial<UnitCosts>): Promise<UnitCosts> {
  return updateSetting(db, APP_SETTINGS_KEYS.unitCosts, DEFAULT_UNIT_COSTS, patch);
}

/** Merge a partial limit change over the current limits and persist it. */
export async function updateUsageLimits(
  db: Database,
  patch: Partial<UsageLimits>,
): Promise<UsageLimits> {
  return updateSetting(db, APP_SETTINGS_KEYS.usageLimits, defaultUsageLimits(), patch);
}

/** The effective backup schedule — stored values over the shipped defaults. */
export async function getBackupSchedule(db: DbOrTx): Promise<BackupSchedule> {
  return getSetting(db, APP_SETTINGS_KEYS.backupSchedule, DEFAULT_BACKUP_SCHEDULE);
}

/** Merge a partial schedule change over the current schedule and persist it. */
export async function updateBackupSchedule(
  db: Database,
  patch: Partial<BackupSchedule>,
): Promise<BackupSchedule> {
  return updateSetting(db, APP_SETTINGS_KEYS.backupSchedule, DEFAULT_BACKUP_SCHEDULE, patch);
}

/** The latest Back up now request, or `null` when none was ever made. */
export async function getBackupRequest(db: DbOrTx): Promise<BackupRequest | null> {
  return readSetting<BackupRequest>(db, APP_SETTINGS_KEYS.backupRequest);
}

/** Record a Back up now press; the sidecar picks it up on its next minute check. */
export async function requestBackup(db: Database, at: Date = new Date()): Promise<BackupRequest> {
  const request: BackupRequest = { requestedAt: at.toISOString() };
  await writeSetting(db, APP_SETTINGS_KEYS.backupRequest, request);
  return request;
}
